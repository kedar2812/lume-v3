import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { newTotpSecret, otpauthUri, safeEqual, verifyTotp } from "@lume/core";
import { ARGON2_PRODUCTION, hashPassword, verifyPassword } from "@lume/core/password";
import type pg from "pg";
import type { Ctx } from "./context";
import { clientIp } from "./http";

/** One admin (R4), argon2 and two-step; sessions httpOnly, Secure, SameSite=Strict, with a CSRF token each. */
export const SESSION_COOKIE = "lume_licence";
export const CSRF_COOKIE = "lume_licence_csrf";
export const PENDING_COOKIE = "lume_licence_pending";
const MIN = 60_000;
const PENDING_MS = 5 * MIN;
export const IDLE_MS = 4 * 60 * MIN;
export const ABSOLUTE_MS = 24 * 60 * MIN;
export const ISSUER = "LUME Licences";
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;
export const SIGN_IN_FAILED = {
  code: "SIGN_IN_FAILED",
  message: "That didn't work. Check the email, password and code, then try again.",
};

const sha = (s: string) => createHash("sha256").update(s).digest();

/** The two-step secret, sealed with LICENCE_MASTER_KEY (AES-256-GCM) and bound to its admin. */
function seal(master: Buffer, plain: string, adminId: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", master, iv).setAAD(Buffer.from(`totp:${adminId}`));
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
function unseal(master: Buffer, blob: Buffer, adminId: string): string {
  const d = createDecipheriv("aes-256-gcm", master, blob.subarray(0, 12)).setAAD(
    Buffer.from(`totp:${adminId}`),
  );
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString("utf8");
}

export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== "string" || [...pw].length < PASSWORD_MIN)
    return `At least ${PASSWORD_MIN} characters, please.`;
  if (pw.length > PASSWORD_MAX) return `At most ${PASSWORD_MAX} characters, please.`;
  return null;
}

/** The one admin (admin:create). Returns the two-step secret to add to an authenticator, shown once. */
export async function createAdmin(
  ctx: Ctx,
  o: { email: string; password: string },
): Promise<{ secret: string; uri: string }> {
  const email = o.email.trim().toLowerCase();
  const problem = passwordProblem(o.password);
  if (problem) throw new Error(problem);
  const { rows } = await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM admins");
  if (rows[0]!.n > 0) throw new Error("There is already an admin. The licence server has one (R4).");
  const secret = newTotpSecret();
  const id = (await ctx.db.query<{ id: string }>("SELECT gen_random_uuid() AS id")).rows[0]!.id;
  await ctx.db.query("INSERT INTO admins (id, email, password_hash, totp_secret) VALUES ($1, $2, $3, $4)", [
    id,
    email,
    await hashPassword(o.password, ARGON2_PRODUCTION),
    seal(ctx.master, secret, id),
  ]);
  return { secret, uri: otpauthUri({ secret, account: email, issuer: ISSUER }) };
}

let dummy: Promise<string> | null = null;
/** An unknown email costs the same argon2 as a known one. */
const dummyHash = () => (dummy ??= hashPassword("not a password anyone has", ARGON2_PRODUCTION));

async function logSignIn(db: pg.Pool, ip: string, email: string | null, outcome: string, at: Date) {
  await db.query("INSERT INTO sign_ins (at, ip, email, outcome) VALUES ($1, $2, $3, $4)", [
    at,
    ip,
    email,
    outcome,
  ]);
}

type AdminRow = {
  id: string;
  email: string;
  password_hash: string;
  totp_secret: Buffer;
  totp_last_step: string | null;
  totp_pending: Buffer | null;
};

/**
 * Step one: the password. Always answers the same, and always makes a pending sign-in, so it never says
 * whether the email or password was right; only the code step decides.
 */
export async function passwordStep(req: Request, ctx: Ctx, body: { email: string; password: string }) {
  const now = ctx.now();
  const ip = clientIp(req);
  const email = body.email.trim().toLowerCase().slice(0, 254);
  const a = (await ctx.db.query<AdminRow>("SELECT * FROM admins WHERE email = $1", [email])).rows[0];
  const ok = a
    ? await verifyPassword(a.password_hash, body.password)
    : (await verifyPassword(await dummyHash(), body.password), false);
  const token = randomBytes(32).toString("base64url");
  await ctx.db.query("DELETE FROM sign_in_pending WHERE expires_at < $1", [now]);
  await ctx.db.query(
    "INSERT INTO sign_in_pending (id, admin_id, password_ok, email, ip, expires_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [sha(token), a?.id ?? null, ok, email, ip, new Date(now.getTime() + PENDING_MS)],
  );
  return { pending: token, expiresS: PENDING_MS / 1000 };
}

/** Step two: the six digits. Only here is the sign-in decided, and it doesn't say which part was wrong. */
export async function codeStep(
  req: Request,
  ctx: Ctx,
  pendingToken: string | null,
  code: string,
): Promise<{ ok: true; session: string; csrf: string } | { ok: false }> {
  const now = ctx.now();
  const ip = clientIp(req);
  if (!pendingToken) {
    await logSignIn(ctx.db, ip, null, "expired", now);
    return { ok: false };
  }
  const p = (
    await ctx.db.query<{ admin_id: string | null; password_ok: boolean; email: string; expires_at: Date }>(
      "DELETE FROM sign_in_pending WHERE id = $1 RETURNING admin_id, password_ok, email, expires_at",
      [sha(pendingToken)],
    )
  ).rows[0];
  if (!p || p.expires_at.getTime() <= now.getTime()) {
    await logSignIn(ctx.db, ip, p?.email ?? null, "expired", now);
    return { ok: false };
  }
  if (!p.admin_id) {
    await logSignIn(ctx.db, ip, p.email, "unknown_email", now);
    return { ok: false };
  }
  const conn = await ctx.db.connect();
  try {
    await conn.query("BEGIN");
    // One code at a time, so the same code can't win twice in a race.
    const a = (await conn.query<AdminRow>("SELECT * FROM admins WHERE id = $1 FOR UPDATE", [p.admin_id]))
      .rows[0]!;
    const step = verifyTotp(unseal(ctx.master, a.totp_secret, a.id), code, {
      nowMs: now.getTime(),
      lastUsedStep: a.totp_last_step === null ? null : Number(a.totp_last_step),
    });
    if (step === null || !p.password_ok) {
      await conn.query("COMMIT");
      await logSignIn(ctx.db, ip, p.email, p.password_ok ? "bad_code" : "bad_password", now);
      return { ok: false };
    }
    await conn.query("UPDATE admins SET totp_last_step = $2 WHERE id = $1", [a.id, step]);
    const session = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    await conn.query(
      `INSERT INTO admin_sessions (id, admin_id, csrf, ip, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $5, $6)`,
      [sha(session), a.id, csrf, ip, now, new Date(now.getTime() + ABSOLUTE_MS)],
    );
    await conn.query("COMMIT");
    await logSignIn(ctx.db, ip, p.email, "ok", now);
    return { ok: true, session, csrf };
  } catch (e) {
    await conn.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    conn.release();
  }
}

export type Admin = { id: string; email: string; sessionId: Buffer; csrf: string };

/** The signed-in admin, or null: a live session not idle for 4 hours nor older than 24. */
export async function sessionAdmin(ctx: Ctx, token: string | null): Promise<Admin | null> {
  if (!token) return null;
  const now = ctx.now();
  const id = sha(token);
  const s = (
    await ctx.db.query<{
      admin_id: string;
      email: string;
      csrf: string;
      last_seen_at: Date;
      expires_at: Date;
    }>(
      `SELECT s.admin_id, a.email, s.csrf, s.last_seen_at, s.expires_at
         FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.id = $1`,
      [id],
    )
  ).rows[0];
  if (!s) return null;
  if (s.expires_at.getTime() <= now.getTime() || now.getTime() - s.last_seen_at.getTime() >= IDLE_MS) {
    await ctx.db.query("DELETE FROM admin_sessions WHERE id = $1", [id]);
    return null;
  }
  await ctx.db.query("UPDATE admin_sessions SET last_seen_at = greatest(last_seen_at, $2) WHERE id = $1", [
    id,
    now,
  ]);
  return { id: s.admin_id, email: s.email, sessionId: id, csrf: s.csrf };
}

export const csrfMatches = (admin: Admin, header: string | null) => !!header && safeEqual(header, admin.csrf);

export async function signOut(req: Request, ctx: Ctx, admin: Admin) {
  await ctx.db.query("DELETE FROM admin_sessions WHERE id = $1", [admin.sessionId]);
  await logSignIn(ctx.db, clientIp(req), admin.email, "signed_out", ctx.now());
}

/** A new password: the current one first. Every other session ends. */
export async function changePassword(
  ctx: Ctx,
  admin: Admin,
  current: string,
  next: string,
): Promise<string | null> {
  const a = (await ctx.db.query<AdminRow>("SELECT * FROM admins WHERE id = $1", [admin.id])).rows[0]!;
  if (!(await verifyPassword(a.password_hash, current))) return "That isn't your current password.";
  const problem = passwordProblem(next);
  if (problem) return problem;
  await ctx.db.query("UPDATE admins SET password_hash = $2 WHERE id = $1", [
    a.id,
    await hashPassword(next, ARGON2_PRODUCTION),
  ]);
  await ctx.db.query("DELETE FROM admin_sessions WHERE admin_id = $1 AND id <> $2", [a.id, admin.sessionId]);
  return null;
}

/** A new two-step secret, kept aside until a code from it confirms the switch (so nobody is locked out). */
export async function startTwoStep(ctx: Ctx, admin: Admin): Promise<{ secret: string; uri: string }> {
  const secret = newTotpSecret();
  await ctx.db.query("UPDATE admins SET totp_pending = $2 WHERE id = $1", [
    admin.id,
    seal(ctx.master, secret, admin.id),
  ]);
  return { secret, uri: otpauthUri({ secret, account: admin.email, issuer: ISSUER }) };
}

export async function confirmTwoStep(ctx: Ctx, admin: Admin, code: string): Promise<boolean> {
  const a = (await ctx.db.query<AdminRow>("SELECT * FROM admins WHERE id = $1", [admin.id])).rows[0]!;
  if (!a.totp_pending) return false;
  const step = verifyTotp(unseal(ctx.master, a.totp_pending, a.id), code, { nowMs: ctx.now().getTime() });
  if (step === null) return false;
  await ctx.db.query(
    "UPDATE admins SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = $2 WHERE id = $1",
    [a.id, step],
  );
  return true;
}
