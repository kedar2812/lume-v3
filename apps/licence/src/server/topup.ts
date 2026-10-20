import { z } from "zod";
import type { Ctx } from "./context";
import { feedbackClient } from "./feedback";
import { clientIp, json, readCapped } from "./http";

/** Exactly what an install sends (core's topUpBody): nothing else is accepted. */
const topUpSchema = z
  .object({
    instanceId: z.string().min(1).max(64),
    licenseKey: z.string().min(1).max(128),
    installId: z.uuid(),
    appVersion: z.string().min(1).max(40),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    askedBy: z
      .object({ name: z.string().trim().min(1).max(120), email: z.string().trim().min(3).max(254) })
      .strict(),
    note: z.string().max(500),
  })
  .strict();

const refuse = (status: number, code: string, message: string) => json(status, { error: { code, message } });
const limited = (retryAfterS: number) =>
  json(
    429,
    { error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." } },
    { "retry-after": String(retryAfterS) },
  );

/**
 * POST /v1/topup (Autopilot spec 2026-10-19 §4): a client's admin asks the owner for more LUME AI this month. From the
 * install its key is bound to, as feedback is (feedbackClient); one open request a month is kept, and asking again
 * says it's already asked. The owner sees it as an alert and adds the top-up on the client's page.
 */
export async function handleTopUp(req: Request, ctx: Ctx): Promise<Response> {
  const now = ctx.now();
  const ip = clientIp(req);
  const byIp = ctx.limits.ip.take(ip, now.getTime());
  if (!byIp.ok) return limited(byIp.retryAfterS);
  const text = await readCapped(req, 8 * 1024);
  if (text === null) return refuse(413, "TOO_LARGE", "Too large.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse(400, "BAD_REQUEST", "Not JSON.");
  }
  const parsed = topUpSchema.safeParse(raw);
  if (!parsed.success) return refuse(400, "BAD_REQUEST", "Not a top-up request.");
  const b = parsed.data;

  // Wrong keys spend the same allowance a check's do, so this door is no better for guessing.
  const pair = `${ip}|${b.instanceId}`;
  const guessing = ctx.limits.wrongKey.check(pair, now.getTime());
  if (!guessing.ok) return limited(guessing.retryAfterS);
  const who = await feedbackClient(ctx.db, b, now);
  if (!who.ok) {
    if (who.status === 401) ctx.limits.wrongKey.take(pair, now.getTime());
    return refuse(who.status, who.code, who.message);
  }
  const byInstall = ctx.limits.topUpInstall.take(b.installId, now.getTime());
  if (!byInstall.ok) return limited(byInstall.retryAfterS);

  const c = await ctx.db.connect();
  try {
    await c.query("BEGIN");
    const kept = await c.query(
      `INSERT INTO topup_requests (client_id, month, asked_at, asked_by_name, asked_by_email, note)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (client_id, month) WHERE done_at IS NULL DO NOTHING`,
      [who.clientId, b.month, now, b.askedBy.name, b.askedBy.email, b.note.trim()],
    );
    if (kept.rowCount)
      await c.query("INSERT INTO events (client_id, at, kind, detail) VALUES ($1, $2, 'topup_requested', $3)", [
        who.clientId,
        now,
        JSON.stringify({ month: b.month, by: b.askedBy.name }),
      ]);
    await c.query("COMMIT");
    return kept.rowCount ? json(201, { asked: true }) : json(200, { asked: true, already: true });
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
