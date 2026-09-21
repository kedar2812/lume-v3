import { and, count, eq, isNull } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { hashRecoveryCode, normalizeRecoveryCode, verifyTotp } from "@lume/core";
import { hashPassword, needsRehash, verifyPassword } from "@lume/core/password";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { setSessionCookie } from "../../auth/cookies";
import { createSession, revokeSession } from "../../auth/sessions";
import {
  THROTTLE,
  accountKey,
  checkThrottle,
  clearThrottle,
  ipKey,
  recordFailure,
} from "../../auth/throttle";
import { tooMany } from "../../http/errors";

export type AuthDeps = Pick<AppDeps, "clock" | "keyring" | "argon2" | "config" | "mailer">;
/** Called once per new lockout (Task 11 wires the security alert email here). */
export type LockoutHook = (req: FastifyRequest, lockedUserId: string | null) => Promise<void>;

const INVALID_CREDENTIALS = {
  error: { code: "INVALID_CREDENTIALS", message: "That email and password don't match." },
};
const INVALID_CODE = { error: { code: "INVALID_CODE", message: "That code didn't work." } };
const NOT_PENDING = { error: { code: "UNAUTHENTICATED", message: "Sign in to continue" } };

// Unknown emails are verified against this, so a miss costs the same time as a wrong password.
let dummyHash: Promise<string> | null = null;

const mfaKey = (userId: string) => `mfa:${userId}`;

export async function login(
  req: FastifyRequest,
  reply: FastifyReply,
  d: AuthDeps,
  email: string,
  password: string,
  onLockout?: LockoutHook,
) {
  const now = d.clock();
  const acct = accountKey(email);
  const ip = ipKey(req.ip);
  const gate = await checkThrottle(req.db, [acct, ip], now);
  if (!gate.allowed) throw tooMany(gate.retryAfterSec);

  const [user] = await req.db.select().from(schema.users).where(eq(schema.users.email, email.trim()));
  dummyHash ??= hashPassword("lume-timing-equaliser-not-a-password", d.argon2);
  const ok = await verifyPassword(user?.passwordHash ?? (await dummyHash), password);
  if (!user || !ok || user.status !== "active") {
    const a = await recordFailure(req.db, acct, THROTTLE.accountLockAfter, now);
    await recordFailure(req.db, ip, THROTTLE.ipLockAfter, now);
    await audit(req, {
      action: a.lockedNow ? "user.login.locked" : "user.login.failed",
      entityType: "user",
      entityId: user?.id ?? null,
      actorUserId: null,
    });
    if (a.lockedNow) await onLockout?.(req, user?.id ?? null);
    // Returned, not thrown: the throttle counters above must commit.
    return reply.code(401).send(INVALID_CREDENTIALS);
  }

  await clearThrottle(req.db, acct, now);
  if (needsRehash(user.passwordHash!, d.argon2)) {
    await req.db
      .update(schema.users)
      .set({ passwordHash: await hashPassword(password, d.argon2) })
      .where(eq(schema.users.id, user.id));
  }
  const stage = user.totpEnabled ? "mfa" : "full";
  const s = await createSession(req.db, {
    userId: user.id,
    stage,
    ip: req.ip,
    userAgent: req.headers["user-agent"] ?? null,
    now,
    policy: req.sessionPolicy,
  });
  setSessionCookie(reply, s.token, s.expiresAt, d.config.cookieSecure);
  if (stage === "full") {
    await req.db.update(schema.users).set({ lastLoginAt: now }).where(eq(schema.users.id, user.id));
    await audit(req, { action: "user.login", entityType: "user", entityId: user.id, actorUserId: user.id });
  } else {
    await audit(req, {
      action: "user.login.password_ok",
      entityType: "user",
      entityId: user.id,
      actorUserId: user.id,
    });
  }
  return { next: stage === "full" ? ("done" as const) : ("otp" as const) };
}

/** Swap the password-only session for a full one (a new token: privilege changed). */
async function completeSignIn(
  req: FastifyRequest,
  reply: FastifyReply,
  d: AuthDeps,
  userId: string,
  method: string,
) {
  const now = d.clock();
  await revokeSession(req.db, req.session!.id, "mfa_completed", now);
  const s = await createSession(req.db, {
    userId,
    stage: "full",
    ip: req.ip,
    userAgent: req.headers["user-agent"] ?? null,
    now,
    policy: req.sessionPolicy,
  });
  setSessionCookie(reply, s.token, s.expiresAt, d.config.cookieSecure);
  await clearThrottle(req.db, mfaKey(userId), now);
  await req.db.update(schema.users).set({ lastLoginAt: now }).where(eq(schema.users.id, userId));
  await audit(req, {
    action: "user.login",
    entityType: "user",
    entityId: userId,
    actorUserId: userId,
    diff: { method },
  });
}

async function pendingUser(req: FastifyRequest, d: AuthDeps): Promise<string | null> {
  const s = req.session;
  if (!s || s.stage !== "mfa") return null;
  const gate = await checkThrottle(req.db, [mfaKey(s.userId)], d.clock());
  if (!gate.allowed) throw tooMany(gate.retryAfterSec);
  return s.userId;
}

async function failSecondFactor(req: FastifyRequest, reply: FastifyReply, d: AuthDeps, userId: string) {
  await recordFailure(req.db, mfaKey(userId), THROTTLE.accountLockAfter, d.clock());
  await audit(req, { action: "user.2fa.failed", entityType: "user", entityId: userId, actorUserId: userId });
  return reply.code(401).send(INVALID_CODE);
}

export async function secondFactor(req: FastifyRequest, reply: FastifyReply, d: AuthDeps, code: string) {
  const userId = await pendingUser(req, d);
  if (!userId) return reply.code(401).send(NOT_PENDING);
  // Row lock: two concurrent submissions of one code can't both pass the replay check.
  const [user] = await req.db.select().from(schema.users).where(eq(schema.users.id, userId)).for("update");
  if (!user?.totpEnabled || !user.totpSecretEnc) return reply.code(401).send(NOT_PENDING);
  const secret = d.keyring.decrypt(user.totpSecretEnc, `totp:${user.id}`);
  const step = verifyTotp(secret, code, { nowMs: d.clock().getTime(), lastUsedStep: user.totpLastStep });
  if (step === null) return failSecondFactor(req, reply, d, userId);
  await req.db.update(schema.users).set({ totpLastStep: step }).where(eq(schema.users.id, userId));
  await completeSignIn(req, reply, d, userId, "totp");
  return { next: "done" as const };
}

export async function recoveryCode(req: FastifyRequest, reply: FastifyReply, d: AuthDeps, code: string) {
  const userId = await pendingUser(req, d);
  if (!userId) return reply.code(401).send(NOT_PENDING);
  const now = d.clock();
  const used = await req.db
    .update(schema.recoveryCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(schema.recoveryCodes.userId, userId),
        eq(schema.recoveryCodes.codeHash, hashRecoveryCode(normalizeRecoveryCode(code))),
        isNull(schema.recoveryCodes.usedAt),
      ),
    )
    .returning({ id: schema.recoveryCodes.id });
  if (used.length === 0) return failSecondFactor(req, reply, d, userId);
  await completeSignIn(req, reply, d, userId, "recovery_code");
  const [left] = await req.db
    .select({ n: count() })
    .from(schema.recoveryCodes)
    .where(and(eq(schema.recoveryCodes.userId, userId), isNull(schema.recoveryCodes.usedAt)));
  return { next: "done" as const, remaining: left?.n ?? 0 };
}
