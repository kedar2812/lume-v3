import { fleetHealthSchema, type FleetHealth, type LicenceNotice, type LicenceType } from "@lume/core";
import type pg from "pg";
import { z } from "zod";
import { hashKey, keyMatches } from "@/lib/keys";
import { answerVerifies, issueToken } from "@/lib/sign";
import { serverState } from "@/lib/state";
import { liveAnnouncements, recordSeen } from "./announcements";
import { planOf } from "./plan";
import type { Ctx } from "./context";
import { clientIp, json, readCapped } from "./http";

/** Exactly what an instance sends (core's checkBody): nothing else is accepted, and nothing about a lead. */
const checkSchema = z
  .object({
    instanceId: z.string().min(1).max(64),
    licenseKey: z.string().min(1).max(128),
    // This install's own random id (spec 2026-10-15 §2.2): a key answers only the install it's bound to. An install
    // from before product keys sends none: answered, never bound, only while no install holds the key, so the
    // licence server and the fleet can be updated in either order.
    installId: z.uuid().optional(),
    appVersion: z.string().min(1).max(40),
    activeUserCount: z.number().int().min(0).max(1_000_000),
    leadCount: z.number().int().min(0).max(1_000_000_000),
    serverTime: z.iso.datetime(),
    // Fleet (spec 2026-10-16 fleet §1): what this LUME can show, its health (counts and fixed keys only), and how
    // many people pressed Got it. Each optional: a LUME from before them sends none.
    accepts: z.array(z.string().min(1).max(32)).max(8).optional(),
    health: fleetHealthSchema.optional(),
    seen: z
      .array(z.object({ id: z.uuid(), people: z.number().int().min(0).max(1_000_000) }).strict())
      .max(3)
      .optional(),
  })
  .strict();
const MAX_BODY = 4096;
const UNAUTHORIZED = { error: { code: "UNAUTHORIZED", message: "Unknown licence." } };

type Row = {
  client_id: string;
  key_hash: Buffer;
  type: LicenceType;
  paid_until: string | null;
  trial_ends: string | null;
  suspended: boolean;
  decommissioned: boolean;
  install_id: string | null;
  activated_at: Date | null;
  released_at: Date | null;
  places: number | null;
  modules: Record<string, boolean>;
};
const DAY = 86_400_000;
/** A rotated key keeps its server going this long, while the client enters the new one (spec 2026-10-15 §2.4). */
export const ROTATE_OVERLAP_MS = 7 * DAY;
const refusal = (status: number, code: string, message: string) => json(status, { error: { code, message } });

/** POST /v1/check (spec §4.3): the key, the state worked out here, the check-in recorded, a signed answer. */
export async function handleCheck(req: Request, ctx: Ctx): Promise<Response> {
  const now = ctx.now();
  const ip = clientIp(req);
  const byIp = ctx.limits.ip.take(ip, now.getTime());
  if (!byIp.ok) return limited(byIp.retryAfterS);

  const text = await readCapped(req, MAX_BODY);
  if (text === null) return json(400, { error: { code: "BAD_REQUEST", message: "Too large." } });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json(400, { error: { code: "BAD_REQUEST", message: "Not JSON." } });
  }
  const parsed = checkSchema.safeParse(raw);
  if (!parsed.success) return json(400, { error: { code: "BAD_REQUEST", message: "Not a licence check." } });
  const b = parsed.data;

  // Wrong keys are limited per address and instance, and never spend the client's own allowance: an
  // instance ID isn't a secret, and anyone who knows one mustn't be able to stop that client checking in.
  const pair = `${ip}|${b.instanceId}`;
  const guessing = ctx.limits.wrongKey.check(pair, now.getTime());
  if (!guessing.ok) return limited(guessing.retryAfterS);

  const { rows } = await ctx.db.query<Row>(
    `SELECT l.client_id, l.key_hash, l.type,
            to_char(l.paid_until, 'YYYY-MM-DD') AS paid_until, to_char(l.trial_ends, 'YYYY-MM-DD') AS trial_ends,
            l.suspended_at IS NOT NULL AS suspended, c.decommissioned_at IS NOT NULL AS decommissioned,
            l.install_id, l.activated_at, l.released_at, l.places, l.modules
       FROM licences l JOIN clients c ON c.id = l.client_id
      WHERE l.instance_id = $1`,
    [b.instanceId],
  );
  const l = rows[0];
  const unknown = () => {
    ctx.limits.wrongKey.take(pair, now.getTime());
    return json(401, UNAUTHORIZED);
  };
  if (!l) return unknown();
  // A key the owner decommissioned answers its own server "suspended", signed, so that LUME pauses.
  let paused = false;
  if (keyMatches(b.licenseKey, l.key_hash)) {
    const inUse = b.installId
      ? (await bindForCheck(ctx, l, b.installId, b.appVersion, ip, now)) === "other"
      : l.install_id !== null;
    if (inUse) return refusal(409, "KEY_IN_USE", "This key is active on another LUME.");
  } else {
    const retired = await retiredKey(ctx.db, l.client_id, b.licenseKey);
    if (!retired) return unknown();
    const fromHolder = !!b.installId && retired.install_id === b.installId;
    const gone = () => refusal(403, "KEY_DECOMMISSIONED", "This key has been decommissioned.");
    if (retired.reason === "decommissioned") {
      if (!fromHolder) return gone();
      paused = true;
    } else if (
      !fromHolder ||
      l.install_id !== b.installId ||
      now.getTime() - retired.retired_at.getTime() >= ROTATE_OVERLAP_MS
    )
      return gone();
  }
  const byInstance = ctx.limits.instance.take(b.instanceId, now.getTime());
  if (!byInstance.ok) return limited(byInstance.retryAfterS);

  const { state, reason } = paused
    ? { state: "suspended" as const, reason: "key_decommissioned" }
    : serverState(
        {
          type: l.type,
          paidUntil: l.paid_until,
          trialEnds: l.trial_ends,
          suspended: l.suspended,
          decommissioned: l.decommissioned,
        },
        now,
      );
  const notice = await record(ctx.db, l.client_id, { ...b, ip, state, now });
  // Only an install that said it can show them gets announcements: an older LUME refuses a payload with a key it
  // doesn't know, and would turn read-only.
  const announcements = b.accepts?.includes("announcements")
    ? await liveAnnouncements(ctx.db, l.client_id, now)
    : undefined;
  // The client's plan (spec 2026-10-17 control §1), likewise only for a LUME that says it can keep one.
  const plan = b.accepts?.includes("plan") ? planOf(l) : undefined;
  const sign = () =>
    issueToken(ctx.signer, now, {
      instanceId: b.instanceId,
      state,
      licenseType: l.type,
      paidUntil: l.paid_until,
      trialEndsAt: l.trial_ends,
      reason,
      notice,
      announcements,
      plan,
    });
  let token = sign();
  // An answer LUME would refuse turns it read-only in 7 days: drop announcements, oldest first, until it verifies.
  while (announcements?.length && !answerVerifies(ctx.signer, token, b.instanceId)) {
    announcements.pop();
    console.warn(`check: an announcement was left out of ${b.instanceId}'s answer so that it verifies`);
    token = sign();
  }
  return json(200, { token });
}

/**
 * Whether this install may check in on the licence's live key (spec 2026-10-15 §2.2): the bound install, yes; a
 * licence never bound binds to it (an install keyed through .env); a released one is answered without binding
 * (only a key entered by hand takes it); any other install is refused, and the owner hears of it at most once an
 * hour from one address.
 */
async function bindForCheck(
  ctx: Ctx,
  l: Row,
  installId: string,
  version: string,
  ip: string,
  now: Date,
): Promise<"ok" | "other"> {
  if (l.install_id === installId) return "ok";
  if (!l.install_id) {
    if (l.released_at || l.activated_at) return "ok";
    const bound = await ctx.db.query(
      `UPDATE licences SET install_id = $2, activated_at = $3, activated_ip = $4
        WHERE client_id = $1 AND install_id IS NULL AND activated_at IS NULL AND released_at IS NULL`,
      [l.client_id, installId, now, ip],
    );
    if (bound.rowCount) {
      await ctx.db.query(
        "INSERT INTO events (client_id, at, kind, detail) VALUES ($1, $2, 'activated', $3)",
        [l.client_id, now, JSON.stringify({ ip, version, via: "check" })],
      );
      return "ok";
    }
    // Another install bound it a moment ago.
    const now2 = (
      await ctx.db.query<{ install_id: string | null }>(
        "SELECT install_id FROM licences WHERE client_id = $1",
        [l.client_id],
      )
    ).rows[0];
    if (!now2?.install_id || now2.install_id === installId) return "ok";
  }
  await ctx.db.query(
    `INSERT INTO events (client_id, at, kind, detail)
     SELECT $1, $2, 'activation_refused', $3
      WHERE NOT EXISTS (SELECT 1 FROM events WHERE client_id = $1 AND kind = 'activation_refused'
                          AND detail->>'ip' = $4 AND at > $2::timestamptz - interval '1 hour')`,
    [l.client_id, now, JSON.stringify({ ip }), ip],
  );
  return "other";
}

/** A retired key of this client's (rotated or decommissioned), or null. */
export async function retiredKey(db: pg.Pool, clientId: string, key: string) {
  return (
    (
      await db.query<{ reason: "rotated" | "decommissioned"; retired_at: Date; install_id: string | null }>(
        "SELECT reason, retired_at, install_id FROM retired_keys WHERE key_hash = $1 AND client_id = $2",
        [hashKey(key), clientId],
      )
    ).rows[0] ?? null
  );
}

/** The check-in, and what changed since the last one (a new version, a new state), in one transaction. */
async function record(
  db: pg.Pool,
  clientId: string,
  c: {
    appVersion: string;
    activeUserCount: number;
    leadCount: number;
    serverTime: string;
    ip: string;
    state: string;
    now: Date;
    health?: FleetHealth;
    accepts?: string[];
    seen?: { id: string; people: number }[];
  },
): Promise<LicenceNotice | null> {
  const conn = await db.connect();
  try {
    await conn.query("BEGIN");
    // One check-in at a time per client, so two racing checks can't both see "no change".
    await conn.query("SELECT 1 FROM licences WHERE client_id = $1 FOR UPDATE", [clientId]);
    const last = (
      await conn.query<{ app_version: string; state: string }>(
        "SELECT app_version, state FROM check_ins WHERE client_id = $1 ORDER BY at DESC, id DESC LIMIT 1",
        [clientId],
      )
    ).rows[0];
    await conn.query(
      `INSERT INTO check_ins (client_id, at, ip, app_version, active_users, lead_count, server_time, state, health, accepts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        clientId,
        c.now,
        c.ip,
        c.appVersion,
        c.activeUserCount,
        c.leadCount,
        c.serverTime,
        c.state,
        c.health ? JSON.stringify(c.health) : null,
        c.accepts ?? null,
      ],
    );
    if (c.seen?.length) await recordSeen(conn, clientId, c.seen, c.now);
    const event = (kind: string, detail: object) =>
      conn.query("INSERT INTO events (client_id, at, kind, detail) VALUES ($1, $2, $3, $4)", [
        clientId,
        c.now,
        kind,
        JSON.stringify(detail),
      ]);
    if (!last) await event("first_check_in", { version: c.appVersion, state: c.state });
    else {
      if (last.app_version !== c.appVersion)
        await event("version", { from: last.app_version, to: c.appVersion });
      if (last.state !== c.state) await event("state", { from: last.state, to: c.state });
    }
    const notice = await openNotice(conn, clientId);
    await conn.query("COMMIT");
    return notice;
  } catch (e) {
    await conn.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

/** The client's open payment reminder, as the token carries it, or null. */
export async function openNotice(
  db: pg.Pool | pg.PoolClient,
  clientId: string,
): Promise<LicenceNotice | null> {
  const n = (
    await db.query<{ id: string; note: string; due_date: string | null; contact: string | null }>(
      `SELECT n.id, n.note, to_char(n.due_date, 'YYYY-MM-DD') AS due_date, s.billing_contact AS contact
         FROM notices n CROSS JOIN settings s
        WHERE n.client_id = $1 AND n.cleared_at IS NULL`,
      [clientId],
    )
  ).rows[0];
  if (!n) return null;
  return {
    id: n.id,
    kind: "payment_due",
    dueDate: n.due_date,
    note: n.note,
    ...(n.contact ? { contact: n.contact } : {}),
  };
}

export function limited(retryAfterS: number): Response {
  return json(
    429,
    { error: { code: "RATE_LIMITED", message: "Too many checks. Try again later." } },
    {
      "retry-after": String(retryAfterS),
    },
  );
}

/** Check-ins are kept 180 days (R3); events, payments and prices forever. */
export async function pruneCheckIns(db: pg.Pool, now: Date): Promise<number> {
  const r = await db.query("DELETE FROM check_ins WHERE at < $1::timestamptz - interval '180 days'", [
    now.toISOString(),
  ]);
  return r.rowCount ?? 0;
}
