import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { newId, randomToken, sha256Hex } from "@lume/core";
import { hashPassword, passwordProblems } from "@lume/core/password";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { setSessionCookie } from "../../auth/cookies";
import { createSession } from "../../auth/sessions";
import { badRequest, conflict, notFound } from "../../http/errors";
import { sendAfterCommit } from "../../mail/mailer";
import { inviteMail } from "../../mail/templates";
import { assertCanAssignRoles } from "../../rbac/escalation";

const TTL_MS = 72 * 3600_000;

export async function createInvite(
  req: FastifyRequest,
  d: AppDeps,
  a: { email: string; name: string; roleIds: string[] },
) {
  const now = d.clock();
  const [existing] = await req.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, a.email));
  if (existing) throw conflict("USER_EXISTS", "That person already has an account");
  if (a.roleIds.length) {
    const found = await req.db
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(inArray(schema.roles.id, a.roleIds), isNull(schema.roles.deletedAt)));
    if (found.length !== new Set(a.roleIds).size)
      throw badRequest("UNKNOWN_ROLE", "One of those roles doesn't exist");
  }
  await assertCanAssignRoles(req, a.roleIds);
  // One live invite per address: a new one replaces any still-open link.
  await req.db
    .update(schema.userInvites)
    .set({ revokedAt: now })
    .where(
      and(
        eq(schema.userInvites.email, a.email),
        isNull(schema.userInvites.acceptedAt),
        isNull(schema.userInvites.revokedAt),
      ),
    );
  const token = randomToken();
  const id = newId();
  const expiresAt = new Date(now.getTime() + TTL_MS);
  await req.db.insert(schema.userInvites).values({
    id,
    email: a.email,
    name: a.name,
    roleIds: a.roleIds,
    tokenHash: sha256Hex(token),
    expiresAt,
    invitedBy: req.actor!.userId,
    createdAt: now,
  });
  const url = `${d.config.publicUrl}/invite/${token}`;
  const [inviter] = await req.db
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, req.actor!.userId));
  const [s] = await req.db.select({ name: schema.settings.businessName }).from(schema.settings);
  sendAfterCommit(
    req,
    d.mailer,
    inviteMail({
      to: a.email,
      name: a.name,
      businessName: s?.name ?? "LUME",
      inviterName: inviter?.name ?? "Someone",
      url,
      expiresAt,
    }),
  );
  await audit(req, {
    action: "user.invited",
    entityType: "invite",
    entityId: id,
    diff: { roleIds: a.roleIds },
  });
  return { invite: { id, email: a.email, expiresAt }, url };
}

async function liveInvite(req: FastifyRequest, d: AppDeps, token: string) {
  const [inv] = await req.db
    .select()
    .from(schema.userInvites)
    .where(
      and(
        eq(schema.userInvites.tokenHash, sha256Hex(token)),
        isNull(schema.userInvites.acceptedAt),
        isNull(schema.userInvites.revokedAt),
        gt(schema.userInvites.expiresAt, d.clock()),
      ),
    )
    .for("update");
  if (!inv) throw notFound();
  return inv;
}

export async function peekInvite(req: FastifyRequest, d: AppDeps, token: string) {
  const inv = await liveInvite(req, d, token);
  const [s] = await req.db.select({ name: schema.settings.businessName }).from(schema.settings);
  return { email: inv.email, name: inv.name, businessName: s?.name ?? "LUME" };
}

export async function acceptInvite(
  req: FastifyRequest,
  reply: FastifyReply,
  d: AppDeps,
  token: string,
  password: string,
) {
  const now = d.clock();
  const inv = await liveInvite(req, d, token);
  const problems = passwordProblems(password, { email: inv.email, isBreached: d.isBreached });
  if (problems.length) throw badRequest("WEAK_PASSWORD", "Choose a stronger password", { problems });
  const [dup] = await req.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, inv.email));
  if (dup) throw conflict("USER_EXISTS", "That person already has an account");
  const userId = newId();
  await req.db.insert(schema.users).values({
    id: userId,
    email: inv.email,
    name: inv.name,
    passwordHash: await hashPassword(password, d.argon2),
    status: "active",
    lastLoginAt: now,
  });
  if (inv.roleIds.length)
    await req.db.insert(schema.userRoles).values(inv.roleIds.map((roleId) => ({ userId, roleId })));
  await req.db.update(schema.userInvites).set({ acceptedAt: now }).where(eq(schema.userInvites.id, inv.id));
  const s = await createSession(req.db, {
    userId,
    stage: "full",
    ip: req.ip,
    userAgent: req.headers["user-agent"] ?? null,
    now,
    policy: req.sessionPolicy,
  });
  setSessionCookie(reply, s.token, s.expiresAt, d.config.cookieSecure);
  await audit(req, {
    action: "user.invite.accepted",
    entityType: "user",
    entityId: userId,
    actorUserId: userId,
    diff: { inviteId: inv.id },
  });
  return reply.code(201).send({ userId });
}

async function openInvite(req: FastifyRequest, id: string) {
  const [inv] = await req.db
    .select()
    .from(schema.userInvites)
    .where(
      and(
        eq(schema.userInvites.id, id),
        isNull(schema.userInvites.acceptedAt),
        isNull(schema.userInvites.revokedAt),
      ),
    );
  if (!inv) throw notFound("INVITE_NOT_FOUND", "That invite isn't open any more");
  return inv;
}

/** Invites still waiting for an answer (Settings -> People), newest first, with who sent them. */
export async function listInvites(req: FastifyRequest, d: AppDeps) {
  const rows = await req.db
    .select()
    .from(schema.userInvites)
    .where(and(isNull(schema.userInvites.acceptedAt), isNull(schema.userInvites.revokedAt)));
  const roleIds = [...new Set(rows.flatMap((r) => r.roleIds))];
  const inviterIds = [...new Set(rows.map((r) => r.invitedBy).filter((x): x is string => !!x))];
  const roles = roleIds.length
    ? await req.db
        .select({ id: schema.roles.id, name: schema.roles.name })
        .from(schema.roles)
        .where(inArray(schema.roles.id, roleIds))
    : [];
  const inviters = inviterIds.length
    ? await req.db
        .select({ id: schema.users.id, name: schema.users.name })
        .from(schema.users)
        .where(inArray(schema.users.id, inviterIds))
    : [];
  const now = d.clock();
  return {
    invites: rows
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        roles: roles.filter((x) => r.roleIds.includes(x.id)),
        invitedBy: inviters.find((x) => x.id === r.invitedBy)?.name ?? null,
        expiresAt: r.expiresAt,
        expired: r.expiresAt.getTime() < now.getTime(),
      })),
  };
}

/** A fresh link for the same person and roles; the old link stops working. */
export async function resendInvite(req: FastifyRequest, d: AppDeps, id: string) {
  const inv = await openInvite(req, id);
  const out = await createInvite(req, d, { email: inv.email, name: inv.name, roleIds: inv.roleIds });
  await audit(req, {
    action: "invite.resent",
    entityType: "invite",
    entityId: out.invite.id,
    diff: { replaces: id },
  });
}

export async function revokeInvite(req: FastifyRequest, d: AppDeps, id: string) {
  await openInvite(req, id);
  await req.db.update(schema.userInvites).set({ revokedAt: d.clock() }).where(eq(schema.userInvites.id, id));
  await audit(req, { action: "invite.revoked", entityType: "invite", entityId: id });
}
