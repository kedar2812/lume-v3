import { and, eq, isNull } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  EMPTY_ONBOARDING,
  EMPTY_TOUR,
  TOUR_VERSION,
  generateRecoveryCodes,
  hashRecoveryCode,
  newId,
  newTotpSecret,
  otpauthUri,
  mergePreferences,
  requiresTwoFactor,
  verifyTotp,
  type OnboardingState,
  type OnboardingStepId,
  type TourState,
} from "@lume/core";
import { verifyPassword } from "@lume/core/password";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { setSessionCookie } from "../../auth/cookies";
import { createSession, revokeSession, revokeUserSessions } from "../../auth/sessions";
import { THROTTLE, checkThrottle, clearThrottle, recordFailure } from "../../auth/throttle";
import { badRequest, forbidden, notFound, tooMany } from "../../http/errors";
import { notifyRbac } from "../../rbac/notify";

export async function listSessions(req: FastifyRequest) {
  const rows = await req.db
    .select()
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.userId, req.actor!.userId),
        isNull(schema.sessions.revokedAt),
        eq(schema.sessions.stage, "full"),
      ),
    );
  return {
    sessions: rows
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
      .map((s) => ({
        id: s.id.slice(0, 16),
        current: s.id === req.session!.id,
        ip: s.ip,
        userAgent: s.userAgent,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
      })),
  };
}

export async function revokeMine(req: FastifyRequest, d: AppDeps, shortId: string) {
  const rows = await req.db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(and(eq(schema.sessions.userId, req.actor!.userId), isNull(schema.sessions.revokedAt)));
  const match = rows.filter((r) => r.id.startsWith(shortId));
  if (match.length !== 1) throw notFound();
  await revokeSession(req.db, match[0]!.id, "revoked_by_user", d.clock());
  await audit(req, { action: "session.revoked", entityType: "user", entityId: req.actor!.userId });
}

export async function beginEnrolment(req: FastifyRequest, d: AppDeps) {
  const [u] = await req.db.select().from(schema.users).where(eq(schema.users.id, req.actor!.userId));
  const secret = newTotpSecret();
  await req.db
    .update(schema.users)
    .set({ totpPendingEnc: d.keyring.encrypt(secret, `totp-pending:${u!.id}`) })
    .where(eq(schema.users.id, u!.id));
  const [s] = await req.db.select({ name: schema.settings.businessName }).from(schema.settings);
  return {
    secret,
    otpauthUri: otpauthUri({ secret, account: u!.email, issuer: `LUME · ${s?.name ?? "LUME"}` }),
  };
}

export async function confirmEnrolment(req: FastifyRequest, reply: FastifyReply, d: AppDeps, code: string) {
  const now = d.clock();
  const [u] = await req.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, req.actor!.userId))
    .for("update");
  if (!u!.totpPendingEnc) throw badRequest("NO_ENROLMENT", "Start two-step setup first");
  const secret = d.keyring.decrypt(u!.totpPendingEnc, `totp-pending:${u!.id}`);
  const step = verifyTotp(secret, code, { nowMs: now.getTime() });
  if (step === null) throw badRequest("INVALID_CODE", "That code didn't work. Check the time on your phone.");
  await req.db
    .update(schema.users)
    .set({
      totpEnabled: true,
      totpSecretEnc: d.keyring.encrypt(secret, `totp:${u!.id}`),
      totpPendingEnc: null,
      totpLastStep: step,
    })
    .where(eq(schema.users.id, u!.id));
  const codes = await replaceRecoveryCodes(req, u!.id);
  // Privilege changed: rotate this session and end all others.
  await revokeUserSessions(req.db, u!.id, "2fa_enabled", now, req.session!.id);
  await revokeSession(req.db, req.session!.id, "rotated", now);
  const s = await createSession(req.db, {
    userId: u!.id,
    stage: "full",
    ip: req.ip,
    userAgent: req.headers["user-agent"] ?? null,
    now,
    policy: req.sessionPolicy,
  });
  setSessionCookie(reply, s.token, s.expiresAt, d.config.cookieSecure);
  await audit(req, { action: "user.2fa.enabled", entityType: "user", entityId: u!.id });
  await notifyRbac(req, u!.id);
  return { recoveryCodes: codes };
}

async function replaceRecoveryCodes(req: FastifyRequest, userId: string): Promise<string[]> {
  await req.db.delete(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, userId));
  const codes = generateRecoveryCodes();
  await req.db
    .insert(schema.recoveryCodes)
    .values(codes.map((c) => ({ id: newId(), userId, codeHash: hashRecoveryCode(c) })));
  return codes;
}

const WRONG_PASSWORD = { error: { code: "WRONG_PASSWORD", message: "That password isn't right" } };
const reauthKey = (userId: string) => `reauth:${userId}`;

/**
 * Re-authentication for sensitive self-service changes. Throttled like login; a wrong password is
 * returned (400, not 401 — the session is fine) rather than thrown, so the failure count commits.
 */
async function confirmPassword(req: FastifyRequest, d: AppDeps, password: string): Promise<boolean> {
  const userId = req.actor!.userId;
  const now = d.clock();
  const gate = await checkThrottle(req.db, [reauthKey(userId)], now);
  if (!gate.allowed) throw tooMany(gate.retryAfterSec);
  const [u] = await req.db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (u?.passwordHash && (await verifyPassword(u.passwordHash, password))) {
    await clearThrottle(req.db, reauthKey(userId), now);
    return true;
  }
  await recordFailure(req.db, reauthKey(userId), THROTTLE.accountLockAfter, now);
  return false;
}

export async function disableTwoFactor(
  req: FastifyRequest,
  reply: FastifyReply,
  d: AppDeps,
  password: string,
) {
  if (requiresTwoFactor(req.actor!))
    throw forbidden("TWO_FACTOR_REQUIRED", "Your role requires two-step sign-in");
  if (!(await confirmPassword(req, d, password))) return reply.code(400).send(WRONG_PASSWORD);
  const userId = req.actor!.userId;
  await req.db
    .update(schema.users)
    .set({ totpEnabled: false, totpSecretEnc: null, totpPendingEnc: null, totpLastStep: null })
    .where(eq(schema.users.id, userId));
  await req.db.delete(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, userId));
  await audit(req, { action: "user.2fa.disabled", entityType: "user", entityId: userId });
  await notifyRbac(req, userId);
  return reply.code(204).send();
}

export async function regenerateRecoveryCodes(
  req: FastifyRequest,
  reply: FastifyReply,
  d: AppDeps,
  password: string,
) {
  if (!(await confirmPassword(req, d, password))) return reply.code(400).send(WRONG_PASSWORD);
  const codes = await replaceRecoveryCodes(req, req.actor!.userId);
  await audit(req, {
    action: "user.recovery_codes.regenerated",
    entityType: "user",
    entityId: req.actor!.userId,
  });
  return { recoveryCodes: codes };
}

export type ProfilePatch = {
  name?: string;
  timezone?: string;
  theme?: "system" | "porcelain" | "obsidian";
  preferences?: unknown;
};

export async function updateProfile(req: FastifyRequest, patch: ProfilePatch) {
  const where = eq(schema.users.id, req.actor!.userId);
  const { preferences, ...columns } = patch;
  const set: Record<string, unknown> = { ...columns };
  if (preferences !== undefined) {
    // Merged onto what is stored, so one screen can save one setting without clearing the others.
    const [current] = await req.db
      .select({ preferences: schema.users.preferences })
      .from(schema.users)
      .where(where);
    set.preferences = mergePreferences(current?.preferences, preferences);
  }
  const [u] = Object.keys(set).length
    ? await req.db.update(schema.users).set(set).where(where).returning()
    : await req.db.select().from(schema.users).where(where);
  await audit(req, {
    action: "user.profile.updated",
    entityType: "user",
    entityId: u!.id,
    diff: { fields: Object.keys(set) },
  });
  return {
    id: u!.id,
    name: u!.name,
    email: u!.email,
    timezone: u!.timezone,
    theme: u!.theme,
    preferences: mergePreferences(u!.preferences, {}),
  };
}

export const onboardingOf = (row: { onboarding: Partial<OnboardingState> }): OnboardingState => ({
  ...EMPTY_ONBOARDING,
  ...row.onboarding,
});
export const tourOf = (row: { tour: Partial<TourState> }): TourState => ({ ...EMPTY_TOUR, ...row.tour });

/** Where onboarding got to, what was skipped, and when it finished (spec §4.2). */
export async function updateOnboarding(
  req: FastifyRequest,
  patch: { step?: OnboardingStepId | null; skip?: OnboardingStepId; completed?: true },
) {
  const userId = req.actor!.userId;
  const [u] = await req.db.select().from(schema.users).where(eq(schema.users.id, userId)).for("update");
  const state = onboardingOf(u!);
  const next: OnboardingState = {
    step: patch.step !== undefined ? patch.step : state.step,
    skipped:
      patch.skip && !state.skipped.includes(patch.skip) ? [...state.skipped, patch.skip] : state.skipped,
    completedAt: patch.completed ? (state.completedAt ?? new Date().toISOString()) : state.completedAt,
  };
  await req.db.update(schema.users).set({ onboarding: next }).where(eq(schema.users.id, userId));
  if (patch.completed && !state.completedAt) {
    await audit(req, {
      action: "user.onboarding.completed",
      entityType: "user",
      entityId: userId,
      diff: { skipped: next.skipped },
    });
  }
  return { onboarding: next };
}

/** Tour progress. A new TOUR_VERSION starts again, so later phases can show only their new steps. */
export async function updateTour(
  req: FastifyRequest,
  patch: { step?: number; completed?: true; skipped?: true },
) {
  const userId = req.actor!.userId;
  const [u] = await req.db.select().from(schema.users).where(eq(schema.users.id, userId)).for("update");
  const stored = tourOf(u!);
  const state = stored.version === TOUR_VERSION ? stored : EMPTY_TOUR;
  const now = new Date().toISOString();
  const next: TourState = {
    version: TOUR_VERSION,
    step: patch.step ?? state.step,
    completedAt: patch.completed ? (state.completedAt ?? now) : state.completedAt,
    skippedAt: patch.skipped ? (state.skippedAt ?? now) : state.skippedAt,
  };
  await req.db.update(schema.users).set({ tour: next }).where(eq(schema.users.id, userId));
  return { tour: next };
}
