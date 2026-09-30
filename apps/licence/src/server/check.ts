import type { LicenceNotice, LicenceType } from "@lume/core";
import type pg from "pg";
import { z } from "zod";
import { keyMatches } from "@/lib/keys";
import { issueToken } from "@/lib/sign";
import { serverState } from "@/lib/state";
import type { Ctx } from "./context";
import { clientIp, json, readCapped } from "./http";

/** Exactly what an instance sends (core's checkBody): nothing else is accepted, and nothing about a lead. */
const checkSchema = z
  .object({
    instanceId: z.string().min(1).max(64),
    licenseKey: z.string().min(1).max(128),
    appVersion: z.string().min(1).max(40),
    activeUserCount: z.number().int().min(0).max(1_000_000),
    leadCount: z.number().int().min(0).max(1_000_000_000),
    serverTime: z.iso.datetime(),
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
};

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
            l.suspended_at IS NOT NULL AS suspended, c.decommissioned_at IS NOT NULL AS decommissioned
       FROM licences l JOIN clients c ON c.id = l.client_id
      WHERE l.instance_id = $1`,
    [b.instanceId],
  );
  const l = rows[0];
  if (!keyMatches(b.licenseKey, l?.key_hash ?? null) || !l) {
    ctx.limits.wrongKey.take(pair, now.getTime());
    return json(401, UNAUTHORIZED);
  }
  const byInstance = ctx.limits.instance.take(b.instanceId, now.getTime());
  if (!byInstance.ok) return limited(byInstance.retryAfterS);

  const { state, reason } = serverState(
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
  const token = issueToken(ctx.signer, now, {
    instanceId: b.instanceId,
    state,
    licenseType: l.type,
    paidUntil: l.paid_until,
    trialEndsAt: l.trial_ends,
    reason,
    notice,
  });
  return json(200, { token });
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
      `INSERT INTO check_ins (client_id, at, ip, app_version, active_users, lead_count, server_time, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [clientId, c.now, c.ip, c.appVersion, c.activeUserCount, c.leadCount, c.serverTime, c.state],
    );
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
    const n = (
      await conn.query<{ id: string; note: string; due_date: string | null; contact: string | null }>(
        `SELECT n.id, n.note, to_char(n.due_date, 'YYYY-MM-DD') AS due_date, s.billing_contact AS contact
           FROM notices n CROSS JOIN settings s
          WHERE n.client_id = $1 AND n.cleared_at IS NULL`,
        [clientId],
      )
    ).rows[0];
    await conn.query("COMMIT");
    if (!n) return null;
    return {
      id: n.id,
      kind: "payment_due",
      dueDate: n.due_date,
      note: n.note,
      ...(n.contact ? { contact: n.contact } : {}),
    };
  } catch (e) {
    await conn.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

function limited(retryAfterS: number): Response {
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
