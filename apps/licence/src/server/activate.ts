import { z } from "zod";
import { issueToken } from "@/lib/sign";
import { serverState } from "@/lib/state";
import { bindOutcome, findByKey } from "./binding";
import { limited, openNotice } from "./check";
import type { Ctx } from "./context";
import { clientIp, json, readCapped } from "./http";

/** Exactly what an instance sends to activate (core's activateBody): nothing else, and nothing about a lead. */
const activateSchema = z
  .object({
    licenseKey: z.string().min(1).max(128),
    installId: z.uuid(),
    appVersion: z.string().min(1).max(40),
    serverTime: z.iso.datetime(),
  })
  .strict();
const MAX_BODY = 2048;
const err = (status: number, code: string, message: string) => json(status, { error: { code, message } });
const UNKNOWN = () => err(401, "UNAUTHORIZED", "Unknown licence.");

/**
 * POST /v1/activate (spec 2026-10-15 §2.1): a key entered at setup (or in Settings → About) binds its licence to
 * the install that entered it. The same install may ask again; any other is refused, and the owner hears of it.
 * A retired key never works again; a paused licence doesn't activate. No check-in is recorded here: an activation
 * carries no counts, and the instance checks in straight after (plan 2026-10-15, Task 3 ruling).
 */
export async function handleActivate(req: Request, ctx: Ctx): Promise<Response> {
  const now = ctx.now();
  const ip = clientIp(req);
  for (const l of [ctx.limits.ip, ctx.limits.activate]) {
    const t = l.take(ip, now.getTime());
    if (!t.ok) return limited(t.retryAfterS);
  }
  const text = await readCapped(req, MAX_BODY);
  if (text === null) return err(400, "BAD_REQUEST", "Too large.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return err(400, "BAD_REQUEST", "Not JSON.");
  }
  const parsed = activateSchema.safeParse(raw);
  if (!parsed.success) return err(400, "BAD_REQUEST", "Not an activation.");
  const b = parsed.data;
  // Wrong keys are limited per address, before the database is asked anything.
  const guessing = ctx.limits.wrongKey.check(ip, now.getTime());
  if (!guessing.ok) return limited(guessing.retryAfterS);

  const c = await ctx.db.connect();
  try {
    await c.query("BEGIN");
    const hit = await findByKey(c, b.licenseKey);
    if (!hit) {
      await c.query("ROLLBACK");
      ctx.limits.wrongKey.take(ip, now.getTime());
      return UNKNOWN();
    }
    if (hit.kind === "retired") {
      await c.query("ROLLBACK");
      return err(403, "KEY_DECOMMISSIONED", "This key has been decommissioned.");
    }
    if (hit.suspended || hit.decommissioned) {
      await c.query("ROLLBACK");
      return err(403, "LICENCE_PAUSED", "This key's licence is paused.");
    }
    const event = (kind: string, detail: object) =>
      c.query("INSERT INTO events (client_id, at, kind, detail) VALUES ($1, $2, $3, $4)", [
        hit.client_id,
        now,
        kind,
        JSON.stringify(detail),
      ]);
    const way = bindOutcome(hit, b.installId);
    if (way === "other") {
      await event("activation_refused", { ip });
      await c.query("COMMIT");
      return err(409, "KEY_IN_USE", "This key is already active on another LUME.");
    }
    if (way === "bind") {
      await c.query(
        `UPDATE licences SET install_id = $2, activated_at = $3, activated_ip = $4, released_at = NULL
          WHERE client_id = $1`,
        [hit.client_id, b.installId, now, ip],
      );
      await event("activated", { ip, version: b.appVersion });
    }
    const notice = await openNotice(c, hit.client_id);
    await c.query("COMMIT");
    const { state, reason } = serverState(
      {
        type: hit.type,
        paidUntil: hit.paid_until,
        trialEnds: hit.trial_ends,
        suspended: hit.suspended,
        decommissioned: hit.decommissioned,
      },
      now,
    );
    const token = issueToken(ctx.signer, now, {
      instanceId: hit.instance_id,
      state,
      licenseType: hit.type,
      paidUntil: hit.paid_until,
      trialEndsAt: hit.trial_ends,
      reason,
      notice,
    });
    return json(200, { instanceId: hit.instance_id, token });
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
