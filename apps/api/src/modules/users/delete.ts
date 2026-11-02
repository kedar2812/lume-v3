import { verifyTotp } from "@lume/core";
import { eq, sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { revokeUserSessions } from "../../auth/sessions";
import { forbidden, notFound } from "../../http/errors";
import { notifyRbac } from "../../rbac/notify";
import { confirmPassword, WRONG_PASSWORD } from "../me/service";
import { offboard, type LeadsChoice } from "./offboard";

const WRONG_CODE = { error: { code: "WRONG_CODE", message: "That code isn't right" } };

/** The address a deleted account keeps: never anyone's, so the real one can be invited again. */
export const deletedEmail = (id: string) => `deleted-${id}@deleted.lume.invalid`;

/**
 * Whoever deletes an account proves it's them (spec 2026-11-02): their password and, with two-step on, their code.
 * Wrong answers are returned, never thrown, so the failure count commits (as every re-authentication).
 */
export async function proveIt(
  req: FastifyRequest,
  reply: FastifyReply,
  d: AppDeps,
  o: { password: string; code?: string | undefined },
): Promise<boolean> {
  if (!(await confirmPassword(req, d, o.password))) {
    void reply.code(400).send(WRONG_PASSWORD);
    return false;
  }
  const [me] = await req.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, req.actor!.userId))
    .for("update");
  if (!me?.totpEnabled || !me.totpSecretEnc) return true;
  const secret = d.keyring.decrypt(me.totpSecretEnc, `totp:${me.id}`);
  const step = o.code
    ? verifyTotp(secret, o.code, { nowMs: d.clock().getTime(), lastUsedStep: me.totpLastStep })
    : null;
  if (step === null) {
    void reply.code(400).send(WRONG_CODE);
    return false;
  }
  await req.db.update(schema.users).set({ totpLastStep: step }).where(eq(schema.users.id, me.id));
  return true;
}

/**
 * Delete an account (owner 2026-11-02; spec docs/superpowers/specs/2026-11-02-delete-account-and-role.md): everything
 * offboarding does (signed out, leads handed on, calendar off, alerts settled), then the person forgotten: name,
 * email, password, two-step, recovery codes, photo, preferences, roles and teams. What they did stays, as done by
 * "Former member". The business owner is never deleted. True when it was; false when the proof was wrong (sent).
 */
export async function deleteAccount(
  req: FastifyRequest,
  reply: FastifyReply,
  d: AppDeps,
  id: string,
  o: { leads: LeadsChoice; password: string; code?: string | undefined },
): Promise<boolean> {
  const [p] = await req.db
    .select({ id: schema.users.id, status: schema.users.status, isOwner: schema.users.isOwner })
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .for("update");
  if (!p || p.status === "deleted") throw notFound("NOT_FOUND", "That person isn't here");
  // The proof first: a wrong password is a wrong password, whoever it's for.
  if (!(await proveIt(req, reply, d, o))) return false;
  await eraseAccount(req, d, id, o.leads);
  return true;
}

/**
 * The act itself, once whoever asked has proved it's them: deleting an account alone, or each person of a role being
 * deleted (one proof for all). The business owner is never deleted.
 */
export async function eraseAccount(req: FastifyRequest, d: AppDeps, id: string, choice: LeadsChoice) {
  const [p] = await req.db
    .select({ id: schema.users.id, status: schema.users.status, isOwner: schema.users.isOwner })
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .for("update");
  if (!p || p.status === "deleted") throw notFound("NOT_FOUND", "That person isn't here");
  if (p.isOwner)
    throw forbidden(
      "OWNER_ACCOUNT",
      "The business owner's account can't be deleted. Make someone else the owner first.",
    );
  const self = id === req.actor!.userId;

  // 1. As offboarding: a disabled person was already offboarded (their leads handed on then).
  const leads =
    p.status === "active" || p.status === "suspended"
      ? (await offboard(req, d, id, choice, { self })).leads
      : null;
  const now = d.clock();
  await revokeUserSessions(req.db, id, "user_deleted", now);

  // 2. LUME AI never speaks as someone who's gone: runs they started, or that speak as them, end.
  await req.db.execute(sql`
    UPDATE autopilot_runs SET status = 'ended', pause_reason = NULL, ended_at = ${now}, updated_at = ${now}
     WHERE (started_by = ${id} OR speaker_id = ${id}) AND status <> 'ended'`);
  // A WhatsApp number that was theirs becomes the business's.
  await req.db.execute(sql`UPDATE whatsapp_numbers SET owner_user_id = NULL WHERE owner_user_id = ${id}`);

  // 3. The person forgotten; the record kept.
  await req.db.delete(schema.userRoles).where(eq(schema.userRoles.userId, id));
  await req.db.execute(sql`DELETE FROM team_members WHERE user_id = ${id}`);
  await req.db.delete(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, id));
  await req.db.delete(schema.userAvatars).where(eq(schema.userAvatars.userId, id));
  await req.db.execute(sql`
    UPDATE users SET name = 'Former member', email = ${deletedEmail(id)}, password_hash = NULL,
           totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled = false, totp_last_step = NULL,
           status = 'deleted', disabled_at = coalesce(disabled_at, ${now}), timezone = NULL, avatar_color = NULL,
           preferences = '{}'::jsonb, last_login_at = NULL, updated_at = ${now}
     WHERE id = ${id}`);

  await notifyRbac(req, id);
  // Never their old email or name: the entry says who and how, not who they were.
  await audit(req, {
    action: "user.deleted",
    entityType: "user",
    entityId: id,
    diff: { by: self ? "self" : "admin", leads },
  });
}
