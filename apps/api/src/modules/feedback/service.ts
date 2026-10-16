import type { FastifyRequest } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import { checkFeedbackImage, FEEDBACK_LIMITS as L, pagePath, type FeedbackReport } from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { conflict, HttpError } from "../../http/errors";
import { SentLog } from "./sent-log";

const sentLog = new SentLog(L.perPersonPerHour, 3_600_000);
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const limited = (retryAfterSec: number) =>
  new HttpError(429, "FEEDBACK_LIMITED", "That's a lot of reports in an hour", { retryAfterSec });
const noKey = () => conflict("NO_LICENCE_KEY", "This LUME has no product key to send feedback under");

/** Who sent it, from the session (never the browser): their name, email, and the client's own words for their role. */
async function reporterOf(req: FastifyRequest): Promise<{ name: string; email: string; role: string }> {
  const me = req.actor!.userId;
  const [u] = await req.db
    .select({ name: schema.users.name, email: schema.users.email, isOwner: schema.users.isOwner })
    .from(schema.users)
    .where(eq(schema.users.id, me));
  const roles = u!.isOwner
    ? []
    : await req.db
        .select({ name: schema.roles.name })
        .from(schema.userRoles)
        .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
        .where(and(eq(schema.userRoles.userId, me), isNull(schema.roles.deletedAt)))
        .orderBy(asc(schema.roles.name));
  const role = u!.isOwner ? "Owner" : roles.length ? roles.map((r) => r.name).join(", ") : "No role";
  return { name: cut(u!.name, L.name), email: String(u!.email).slice(0, L.email), role: cut(role, L.role) };
}

/**
 * Send feedback (spec 2026-10-16 §1.4): checked here, forwarded at once to the licence server under this install's
 * key, and kept nowhere — only an audit line with its kind and how many screenshots.
 */
export async function sendFeedback(req: FastifyRequest, body: FeedbackReport): Promise<{ ok: true }> {
  const me = req.actor!.userId;
  const wait = sentLog.wait(me, Date.now());
  if (wait) throw limited(wait);
  if (!req.server.licence.canSendFeedback()) throw noKey();
  for (const [index, img] of body.images.entries()) {
    const c = checkFeedbackImage(Buffer.from(img.data, "base64"));
    if (!c.ok || c.type !== img.type)
      throw new HttpError(422, "FEEDBACK_IMAGE_REFUSED", "LUME can't send this screenshot", { index });
  }
  const report: FeedbackReport = { ...body, text: body.text.trim(), page: pagePath(body.page) };
  const out = await req.server.licence.sendFeedback({
    browser: String(req.headers["user-agent"] ?? "").slice(0, L.browser),
    reporter: await reporterOf(req),
    report,
  });
  if (!out.ok) {
    if (out.reason === "limited") throw limited(out.retryAfterS ?? 3600);
    if (out.reason === "image")
      throw new HttpError(422, "FEEDBACK_IMAGE_REFUSED", "LUME can't send this screenshot", {
        index: out.index ?? 0,
      });
    if (out.reason === "no_key") throw noKey();
    if (out.reason === "licence")
      throw conflict("FEEDBACK_LICENCE", "This LUME's licence can't send feedback right now");
    throw new HttpError(503, "FEEDBACK_UNREACHABLE", "LUME couldn't reach its team just now");
  }
  sentLog.record(me, Date.now());
  await audit(req, {
    action: "feedback.sent",
    entityType: "feedback",
    diff: { kind: report.kind, images: report.images.length },
  });
  return { ok: true };
}
