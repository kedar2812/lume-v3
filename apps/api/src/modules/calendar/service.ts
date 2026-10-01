import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { instanceIdOf, newId, sign, unseal, verify, type Handoff } from "@lume/core";
import { schema, type ConnectedCalendar } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, notFound } from "../../http/errors";
import { GoogleError, isTransient } from "../sheets/google";
import { calendarClientFor, type CalendarListEntry } from "./google";

const CC = schema.calendarConnections;
const OC = schema.oauthConnects;
type Connection = typeof CC.$inferSelect;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const notConfigured = () =>
  new HttpError(409, "NOT_CONFIGURED", "Connect with Google isn't set up on this server.");
const notConnected = () =>
  notFound("CALENDAR_NOT_CONNECTED", "Your calendar isn't connected to LUME. Connect it first.");

/** The connect panel's view of a person's connection (never the grant, never a sync token). */
function view(d: AppDeps, c: Connection | undefined) {
  const available = !!d.googleOAuth;
  if (!c) return { available, connected: false as const };
  return {
    available,
    connected: true as const,
    googleEmail: c.googleEmail,
    status: c.status,
    calendars: c.calendars.map(({ id, name, chosen }) => ({ id, name, chosen })),
    lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
    lastError: c.lastError,
  };
}

async function mine(req: FastifyRequest, lock = false): Promise<Connection | undefined> {
  const q = req.db.select().from(CC).where(eq(CC.userId, req.actor!.userId));
  const [row] = await (lock ? q.for("update") : q);
  return row;
}

export async function connectionView(req: FastifyRequest, d: AppDeps) {
  return view(d, await mine(req));
}

/** A signed link to the relay, as a calendar's: the kind is signed with the nonce (Task 1). */
export async function calendarConnectStart(req: FastifyRequest, d: AppDeps) {
  if (!d.googleOAuth) throw notConfigured();
  const { relayUrl, relayToken } = d.googleOAuth;
  const nonce = randomBytes(24).toString("base64url");
  await req.db.insert(OC).values({
    id: newId(),
    userId: req.actor!.userId,
    nonceHash: sha256(nonce),
    kind: "calendar",
  });
  const url = new URL("/start", relayUrl);
  url.search = new URLSearchParams({
    i: instanceIdOf(relayToken),
    n: nonce,
    k: "calendar",
    s: sign(relayToken, `${nonce}.calendar`),
  }).toString();
  return { url: url.toString() };
}

/** The account's calendars, read with the new grant; Google's refusals in LUME's words. */
async function calendarsOf(d: AppDeps, refreshToken: string): Promise<CalendarListEntry[]> {
  const google = calendarClientFor(d.googleOAuth, d.googleEndpoint)(refreshToken);
  if (!google) throw notConfigured();
  try {
    return await google.calendarList();
  } catch (e) {
    if (e instanceof GoogleError && e.kind === "access")
      throw new HttpError(
        409,
        "CALENDAR_NO_ACCESS",
        "Google didn't let LUME read your calendars. Connect again and allow both choices Google asks about.",
      );
    if (e instanceof GoogleError && e.kind === "setup")
      throw new HttpError(
        503,
        "GOOGLE_SETUP",
        "LUME's Google connection isn't set up right. Tell the person who installed LUME.",
      );
    if (isTransient(e))
      throw new HttpError(503, "GOOGLE_UNAVAILABLE", "LUME couldn't reach Google. Try again in a minute.");
    throw e;
  }
}

/**
 * Back from Google (spec §2.1): the hand-back must be signed and sealed with this instance's token, a
 * calendar's, fresh, and match a calendar connect this same person started — once. The grant is sealed to
 * the person's one connection; connecting again keeps the calendars they chose.
 */
export async function calendarConnectComplete(
  req: FastifyRequest,
  d: AppDeps,
  body: { p: string; s: string },
) {
  if (!d.googleOAuth) throw notConfigured();
  const token = d.googleOAuth.relayToken;
  const invalid = () =>
    badRequest("CONNECT_INVALID", "This connection isn't valid. Try connecting your calendar again.");
  if (!verify(token, body.p, body.s)) throw invalid();
  const h = unseal<Handoff>(token, body.p);
  if (!h || h.kind !== "calendar" || typeof h.nonce !== "string" || typeof h.refreshToken !== "string")
    throw invalid();
  if (h.exp < Date.now())
    throw badRequest("CONNECT_EXPIRED", "This connection took too long. Try connecting your calendar again.");
  const uid = req.actor!.userId;
  // Locked: two tabs completing the same hand-back at once — the second waits, then finds it used.
  const [open] = await req.db
    .select({ id: OC.id })
    .from(OC)
    .where(
      and(
        eq(OC.nonceHash, sha256(h.nonce)),
        eq(OC.userId, uid),
        eq(OC.kind, "calendar"),
        isNull(OC.completedAt),
      ),
    )
    .for("update");
  if (!open)
    throw notFound("CONNECT_NOT_FOUND", "This connection was already used, or isn't yours. Try again.");
  const list = await calendarsOf(d, h.refreshToken);
  const primary = list.find((c) => c.primary) ?? list[0];
  if (!primary) throw new HttpError(409, "CALENDAR_NONE", "LUME found no calendar on this Google account.");
  await req.db.delete(OC).where(eq(OC.id, open.id));

  let was = await mine(req, true);
  // Another Google account: what LUME kept from the old one goes with it (its meetings included).
  if (was && was.googleEmail !== primary.id) {
    await req.db.delete(CC).where(eq(CC.id, was.id));
    was = undefined;
  }
  const prior = new Map((was?.calendars ?? []).map((c) => [c.id, c]));
  const calendars: ConnectedCalendar[] = list.map((c) => ({
    id: c.id,
    name: c.name,
    chosen: prior.get(c.id)?.chosen ?? (was ? false : c.id === primary.id),
    syncToken: prior.get(c.id)?.syncToken ?? null,
  }));
  const id = was?.id ?? newId();
  const fields = {
    googleEmail: primary.id,
    grantEnc: d.keyring.encrypt(h.refreshToken, `calendar-connection:${id}`),
    calendars,
    status: "active" as const,
    failures: 0,
    lastError: null,
    nextSyncAt: new Date(),
    updatedAt: new Date(),
  };
  if (was) await req.db.update(CC).set(fields).where(eq(CC.id, id));
  else await req.db.insert(CC).values({ id, userId: uid, ...fields });
  await audit(req, {
    action: was ? "calendar.reconnected" : "calendar.connected",
    entityType: "calendar_connection",
    entityId: id,
    diff: { calendars: calendars.filter((c) => c.chosen).length },
  });
  req.afterCommit(() => void d.calendar?.enqueue(id));
  return view(d, await mine(req));
}

/** Which calendars LUME reads. One no longer chosen takes its meetings with it; a newly chosen one is read in full. */
export async function chooseCalendars(req: FastifyRequest, d: AppDeps, ids: string[]) {
  const c = await mine(req, true);
  if (!c) throw notConnected();
  const known = new Set(c.calendars.map((x) => x.id));
  if (ids.some((x) => !known.has(x)))
    throw badRequest(
      "CALENDAR_UNKNOWN",
      "That calendar isn't on your Google account any more. Reload and try again.",
    );
  const want = new Set(ids);
  const dropped = c.calendars.filter((x) => x.chosen && !want.has(x.id)).map((x) => x.id);
  const calendars = c.calendars.map((x) => ({
    ...x,
    chosen: want.has(x.id),
    syncToken: want.has(x.id) && x.chosen ? (x.syncToken ?? null) : null,
  }));
  if (dropped.length)
    await req.db
      .delete(schema.meetings)
      .where(and(eq(schema.meetings.connectionId, c.id), inArray(schema.meetings.calendarId, dropped)));
  await req.db
    .update(CC)
    .set({ calendars, nextSyncAt: new Date(), updatedAt: new Date() })
    .where(eq(CC.id, c.id));
  await audit(req, {
    action: "calendar.calendars_changed",
    entityType: "calendar_connection",
    entityId: c.id,
    diff: { calendars: want.size },
  });
  req.afterCommit(() => void d.calendar?.enqueue(c.id));
  return view(d, await mine(req));
}

/** Sync now: LUME reads the calendar at once rather than at its next turn. */
export async function syncCalendarNow(req: FastifyRequest, d: AppDeps) {
  if (!d.googleOAuth) throw notConfigured();
  const c = await mine(req);
  if (!c) throw notConnected();
  if (c.status === "needs_reconnect")
    throw new HttpError(
      409,
      "CALENDAR_NEEDS_RECONNECT",
      "Google stopped letting LUME read your calendar. Connect it again.",
    );
  await req.db.update(CC).set({ nextSyncAt: new Date() }).where(eq(CC.id, c.id));
  req.afterCommit(() => void d.calendar?.enqueue(c.id));
  return { queued: true };
}

/** Disconnect (spec §2.6 decision 2): the grant and every meeting the connection brought, linked or not. */
export async function disconnectCalendar(req: FastifyRequest, d: AppDeps) {
  const c = await mine(req, true);
  if (!c) throw notConnected();
  const [n] = await req.db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.meetings)
    .where(eq(schema.meetings.connectionId, c.id));
  await req.db.delete(CC).where(eq(CC.id, c.id));
  await audit(req, {
    action: "calendar.disconnected",
    entityType: "calendar_connection",
    entityId: c.id,
    diff: { meetings: n?.n ?? 0 },
  });
  return view(d, undefined);
}
