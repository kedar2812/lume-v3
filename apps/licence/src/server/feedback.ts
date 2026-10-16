import { checkFeedbackImage, FEEDBACK_KINDS, FEEDBACK_LIMITS as L, FEEDBACK_THEMES } from "@lume/core";
import type pg from "pg";
import { z } from "zod";
import { keyMatches } from "@/lib/keys";
import { retiredKey, ROTATE_OVERLAP_MS } from "./check";
import type { Ctx } from "./context";
import { clientIp, json, readCapped } from "./http";

const base64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Exactly what an install sends (core's feedbackBody): nothing else is accepted. */
const feedbackSchema = z
  .object({
    instanceId: z.string().min(1).max(64),
    licenseKey: z.string().min(1).max(128),
    installId: z.uuid(),
    appVersion: z.string().min(1).max(40),
    browser: z.string().max(L.browser),
    reporter: z
      .object({
        name: z.string().trim().min(1).max(L.name),
        email: z.string().trim().min(3).max(L.email),
        role: z.string().trim().min(1).max(L.role),
      })
      .strict(),
    kind: z.enum(FEEDBACK_KINDS),
    text: z
      .string()
      .max(L.text)
      .refine((t) => t.trim().length > 0),
    page: z
      .string()
      .max(L.page)
      .regex(/^\/(?!\/)/),
    theme: z.enum(FEEDBACK_THEMES),
    screen: z.string().min(1).max(L.screen),
    images: z
      .array(
        z
          .object({
            type: z.enum(["image/webp", "image/jpeg"]),
            // 1.5 MB is 2,097,152 characters of base64.
            data: z.string().min(1).max(2_097_152).regex(base64),
          })
          .strict(),
      )
      .max(L.images),
  })
  .strict();
type Body = z.infer<typeof feedbackSchema>;

const refuse = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  json(status, { error: { code, message, ...extra } });
const limited = (retryAfterS: number) =>
  json(
    429,
    { error: { code: "RATE_LIMITED", message: "Too many reports. Try again later." } },
    { "retry-after": String(retryAfterS) },
  );

type Who = { ok: true; clientId: string } | { ok: false; status: number; code: string; message: string };
const UNKNOWN: Who = { ok: false, status: 401, code: "UNAUTHORIZED", message: "Unknown licence." };
const GONE: Who = { ok: false, status: 403, code: "KEY_DECOMMISSIONED", message: "This key has been decommissioned." };

/**
 * Which client a report is from, if the install may send one (spec 2026-10-16 §2.1): the install the licence's live
 * key is bound to, or the holder of a rotated key within its 7 days. A paused licence may; a released key, another
 * install, a decommissioned key or client may not. Never binds anything: feedback is not an activation.
 */
export async function feedbackClient(
  db: pg.Pool,
  b: Pick<Body, "instanceId" | "licenseKey" | "installId">,
  now: Date,
): Promise<Who> {
  const { rows } = await db.query<{
    client_id: string;
    key_hash: Buffer;
    install_id: string | null;
    decommissioned: boolean;
  }>(
    `SELECT l.client_id, l.key_hash, l.install_id, c.decommissioned_at IS NOT NULL AS decommissioned
       FROM licences l JOIN clients c ON c.id = l.client_id
      WHERE l.instance_id = $1`,
    [b.instanceId],
  );
  const l = rows[0];
  if (!l) return UNKNOWN;
  if (keyMatches(b.licenseKey, l.key_hash)) {
    if (l.decommissioned) return GONE;
    if (l.install_id !== b.installId)
      return { ok: false, status: 409, code: "KEY_IN_USE", message: "This key is active on another LUME." };
    return { ok: true, clientId: l.client_id };
  }
  const retired = await retiredKey(db, l.client_id, b.licenseKey);
  if (!retired) return UNKNOWN;
  if (
    l.decommissioned ||
    retired.reason !== "rotated" ||
    retired.install_id !== b.installId ||
    l.install_id !== b.installId ||
    now.getTime() - retired.retired_at.getTime() >= ROTATE_OVERLAP_MS
  )
    return GONE;
  return { ok: true, clientId: l.client_id };
}

/** POST /v1/feedback (spec 2026-10-16 §2.1): a report from a client's LUME, checked again, kept with its screenshots. */
export async function handleFeedback(req: Request, ctx: Ctx): Promise<Response> {
  const now = ctx.now();
  const ip = clientIp(req);
  // A flood from one address is turned away before anything is read.
  const byIp = ctx.limits.feedbackIp.check(ip, now.getTime());
  if (!byIp.ok) return limited(byIp.retryAfterS);

  const text = await readCapped(req, L.bodyBytes);
  if (text === null) return refuse(413, "TOO_LARGE", "A report is 12 MB at most.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse(400, "BAD_REQUEST", "Not JSON.");
  }
  const parsed = feedbackSchema.safeParse(raw);
  if (!parsed.success) return refuse(400, "BAD_REQUEST", "Not a feedback report.");
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

  const images: { type: "image/webp" | "image/jpeg"; width: number; height: number; bytes: Buffer }[] = [];
  for (const [index, img] of b.images.entries()) {
    const bytes = Buffer.from(img.data, "base64");
    const c = checkFeedbackImage(bytes);
    if (!c.ok || c.type !== img.type)
      return refuse(422, "FEEDBACK_IMAGE_REFUSED", `Screenshot ${index + 1} can't be kept.`, { index });
    images.push({ type: c.type, width: c.width, height: c.height, bytes });
  }

  const byInstall = ctx.limits.feedbackInstall.take(b.installId, now.getTime());
  if (!byInstall.ok) return limited(byInstall.retryAfterS);
  const spent = ctx.limits.feedbackIp.take(ip, now.getTime());
  if (!spent.ok) return limited(spent.retryAfterS);

  const c = await ctx.db.connect();
  try {
    await c.query("BEGIN");
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO feedback (client_id, received_at, kind, text, reporter_name, reporter_email, reporter_role, page,
                             app_version, browser, screen, theme, image_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        who.clientId,
        now,
        b.kind,
        b.text.trim(),
        b.reporter.name,
        b.reporter.email,
        b.reporter.role,
        b.page,
        b.appVersion,
        b.browser,
        b.screen,
        b.theme,
        images.length,
      ],
    );
    const id = rows[0]!.id;
    for (const [n, img] of images.entries())
      await c.query(
        "INSERT INTO feedback_images (feedback_id, n, type, width, height, bytes) VALUES ($1, $2, $3, $4, $5, $6)",
        [id, n, img.type, img.width, img.height, img.bytes],
      );
    await c.query("INSERT INTO events (client_id, at, kind, detail) VALUES ($1, $2, 'feedback_received', $3)", [
      who.clientId,
      now,
      { id, kind: b.kind },
    ]);
    await c.query("COMMIT");
    return json(201, { id });
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
