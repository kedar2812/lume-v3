import { and, eq, isNull, ne } from "drizzle-orm";
import type pg from "pg";
import { randomToken, sha256Hex } from "@lume/core";
import { schema, type SecuritySettings } from "@lume/db";
import type { Db } from "../db/context";

export type SessionPolicy = { idleMs: number; absoluteMs: number; mfaPendingMs: number };
const H = 3_600_000;

export function sessionPolicy(s: SecuritySettings | undefined): SessionPolicy {
  return {
    idleMs: (s?.sessionIdleHours ?? 12) * H,
    absoluteMs: (s?.sessionAbsoluteDays ?? 7) * 24 * H,
    mfaPendingMs: 5 * 60_000,
  };
}

export type LiveSession = {
  id: string;
  userId: string;
  stage: "mfa" | "full";
  lastSeenAt: Date;
  user: { status: "invited" | "active" | "disabled"; isOwner: boolean; totpEnabled: boolean };
};

export async function createSession(
  db: Db,
  a: {
    userId: string;
    stage: "mfa" | "full";
    ip: string | null;
    userAgent: string | null;
    now: Date;
    policy: SessionPolicy;
  },
): Promise<{ token: string; id: string; expiresAt: Date }> {
  const token = randomToken();
  const id = sha256Hex(token);
  const expiresAt = new Date(
    a.now.getTime() + (a.stage === "mfa" ? a.policy.mfaPendingMs : a.policy.absoluteMs),
  );
  await db.insert(schema.sessions).values({
    id,
    userId: a.userId,
    stage: a.stage,
    ip: a.ip,
    userAgent: a.userAgent?.slice(0, 400) ?? null,
    createdAt: a.now,
    lastSeenAt: a.now,
    expiresAt,
  });
  return { token, id, expiresAt };
}

/**
 * Resolves a cookie token to a live session. Enforces revoked, absolute and idle expiry and the user's status;
 * a disabled user's sessions are revoked on sight. Runs outside the request transaction (auth happens first).
 */
export async function readSession(
  pool: pg.Pool,
  token: string,
  now: Date,
  policy: SessionPolicy,
): Promise<LiveSession | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const id = sha256Hex(token);
  const { rows } = await pool.query(
    `SELECT s.id, s.user_id, s.stage, s.last_seen_at, s.expires_at, s.revoked_at, u.status, u.is_owner, u.totp_enabled
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r || r.revoked_at) return null;
  if (r.expires_at <= now) return null;
  if (r.stage === "full" && now.getTime() - r.last_seen_at.getTime() > policy.idleMs) {
    await pool.query(
      "UPDATE sessions SET revoked_at = $2, revoked_reason = 'idle' WHERE id = $1 AND revoked_at IS NULL",
      [id, now],
    );
    return null;
  }
  if (r.status !== "active") {
    await pool.query(
      "UPDATE sessions SET revoked_at = $2, revoked_reason = 'user_disabled' WHERE user_id = $1 AND revoked_at IS NULL",
      [r.user_id, now],
    );
    return null;
  }
  // Writing last_seen_at on every request would churn the table; once a minute is plenty for idle expiry.
  if (now.getTime() - r.last_seen_at.getTime() > 60_000)
    await pool.query("UPDATE sessions SET last_seen_at = $2 WHERE id = $1", [id, now]);
  return {
    id,
    userId: r.user_id,
    stage: r.stage,
    lastSeenAt: r.last_seen_at,
    user: { status: r.status, isOwner: r.is_owner, totpEnabled: r.totp_enabled },
  };
}

export async function revokeSession(db: Db, id: string, reason: string, now: Date): Promise<void> {
  await db
    .update(schema.sessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(schema.sessions.id, id), isNull(schema.sessions.revokedAt)));
}

export async function revokeUserSessions(
  db: Db,
  userId: string,
  reason: string,
  now: Date,
  exceptId?: string,
): Promise<number> {
  const where = [eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)];
  if (exceptId) where.push(ne(schema.sessions.id, exceptId));
  const res = await db
    .update(schema.sessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(...where))
    .returning({ id: schema.sessions.id });
  return res.length;
}
