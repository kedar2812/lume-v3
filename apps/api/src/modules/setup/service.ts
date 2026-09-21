import { sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  DEFAULT_ROLES,
  generateRecoveryCodes,
  hashRecoveryCode,
  newId,
  safeEqual,
  verifyTotp,
} from "@lume/core";
import { hashPassword, passwordProblems } from "@lume/core/password";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { setSessionCookie } from "../../auth/cookies";
import { createSession } from "../../auth/sessions";
import type { Db } from "../../db/context";
import { badRequest, forbidden } from "../../http/errors";
import { notifyRbac } from "../../rbac/notify";

export type SetupInput = {
  token: string;
  business: { name: string; timezone: string; currency: string; defaultCountry: string };
  preset: "coaching" | "general";
  owner: { name: string; email: string; password: string };
  totp: { secret: string; code: string };
};

/** Phase 1B registers pipeline/field/template seeding here; it runs inside the setup transaction. */
export const presetAppliers: Array<(db: Db, preset: SetupInput["preset"]) => Promise<void>> = [];

function assertToken(d: AppDeps, token: string) {
  const current = d.setupTokens.current();
  if (!current || !safeEqual(current, token)) throw forbidden("SETUP_TOKEN", "That setup token isn't valid");
}

export async function runSetup(req: FastifyRequest, reply: FastifyReply, d: AppDeps, input: SetupInput) {
  assertToken(d, input.token);
  const now = d.clock();
  const problems = passwordProblems(input.owner.password, {
    email: input.owner.email,
    isBreached: d.isBreached,
  });
  if (problems.length) throw badRequest("WEAK_PASSWORD", "Choose a stronger password", { problems });
  const step = verifyTotp(input.totp.secret, input.totp.code, { nowMs: now.getTime() });
  if (step === null) {
    return reply.code(400).send({
      error: { code: "INVALID_CODE", message: "That code didn't work. Check the time on your phone." },
    });
  }
  // Serialise concurrent setups; then prove nobody finished first.
  await req.db.execute(sql`SELECT pg_advisory_xact_lock(4242)`);
  const existing = await req.db.execute(sql`SELECT 1 FROM users LIMIT 1`);
  if (existing.rows.length) throw forbidden("SETUP_TOKEN", "LUME is already set up");

  await req.db.insert(schema.settings).values({
    businessName: input.business.name,
    timezone: input.business.timezone,
    currency: input.business.currency,
    defaultCountryIso: input.business.defaultCountry,
    industryPreset: input.preset,
  });
  const ownerId = newId();
  await req.db.insert(schema.users).values({
    id: ownerId,
    email: input.owner.email,
    name: input.owner.name,
    passwordHash: await hashPassword(input.owner.password, d.argon2),
    status: "active",
    isOwner: true,
    timezone: input.business.timezone,
    totpEnabled: true,
    totpSecretEnc: d.keyring.encrypt(input.totp.secret, `totp:${ownerId}`),
    totpLastStep: step, // the code typed during setup can never be replayed at sign-in
    lastLoginAt: now,
  });
  for (const role of DEFAULT_ROLES) {
    const roleId = newId();
    await req.db.insert(schema.roles).values({
      id: roleId,
      name: role.name,
      description: role.description,
      color: role.color,
      createdBy: ownerId,
    });
    await req.db
      .insert(schema.rolePermissions)
      .values(role.grants.map((g) => ({ roleId, permissionKey: g.key, scope: g.scope })));
    if (role.name === "Admin") await req.db.insert(schema.userRoles).values({ userId: ownerId, roleId });
  }
  const codes = generateRecoveryCodes();
  await req.db
    .insert(schema.recoveryCodes)
    .values(codes.map((c) => ({ id: newId(), userId: ownerId, codeHash: hashRecoveryCode(c) })));
  for (const apply of presetAppliers) await apply(req.db, input.preset);
  const s = await createSession(req.db, {
    userId: ownerId,
    stage: "full",
    ip: req.ip,
    userAgent: req.headers["user-agent"] ?? null,
    now,
    policy: req.sessionPolicy,
  });
  setSessionCookie(reply, s.token, s.expiresAt, d.config.cookieSecure);
  await audit(req, {
    action: "setup.completed",
    entityType: "settings",
    entityId: "1",
    actorUserId: ownerId,
    diff: { preset: input.preset },
  });
  await notifyRbac(req.db);
  d.setupTokens.burn();
  return reply.code(201).send({ recoveryCodes: codes });
}
