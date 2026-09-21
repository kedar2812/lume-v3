import { and, count, eq, gt, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { newId, randomToken, sha256Hex } from "@lume/core";
import { hashPassword, passwordProblems } from "@lume/core/password";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { revokeUserSessions } from "../../auth/sessions";
import { badRequest } from "../../http/errors";
import { sendAfterCommit } from "../../mail/mailer";
import { resetMail } from "../../mail/templates";

/** Always the same response: whether the email exists is never revealed. */
export async function forgotPassword(req: FastifyRequest, d: AppDeps, email: string): Promise<void> {
  const now = d.clock();
  const [u] = await req.db.select().from(schema.users).where(eq(schema.users.email, email.trim()));
  if (!u || u.status !== "active") return;
  // At most three reset emails per account per 15 minutes: the form can't be used to flood an inbox.
  const recent = await req.db
    .select({ n: count() })
    .from(schema.passwordResets)
    .where(
      and(
        eq(schema.passwordResets.userId, u.id),
        gt(schema.passwordResets.createdAt, new Date(now.getTime() - 15 * 60_000)),
      ),
    );
  if ((recent[0]?.n ?? 0) >= 3) return;
  const token = randomToken();
  await req.db.insert(schema.passwordResets).values({
    id: newId(),
    userId: u.id,
    tokenHash: sha256Hex(token),
    expiresAt: new Date(now.getTime() + 30 * 60_000),
    createdAt: now,
  });
  const [s] = await req.db.select({ name: schema.settings.businessName }).from(schema.settings);
  sendAfterCommit(
    req,
    d.mailer,
    resetMail({ to: u.email, businessName: s?.name ?? "LUME", url: `${d.config.publicUrl}/reset/${token}` }),
  );
  await audit(req, {
    action: "user.password.reset_requested",
    entityType: "user",
    entityId: u.id,
    actorUserId: null,
  });
}

export async function resetPassword(
  req: FastifyRequest,
  d: AppDeps,
  token: string,
  password: string,
): Promise<void> {
  const now = d.clock();
  const [r] = await req.db
    .select()
    .from(schema.passwordResets)
    .where(
      and(
        eq(schema.passwordResets.tokenHash, sha256Hex(token)),
        isNull(schema.passwordResets.usedAt),
        gt(schema.passwordResets.expiresAt, now),
      ),
    )
    .for("update");
  if (!r) throw badRequest("INVALID_TOKEN", "That reset link has expired. Ask for a new one.");
  const [u] = await req.db.select().from(schema.users).where(eq(schema.users.id, r.userId));
  const problems = passwordProblems(password, { email: u!.email, isBreached: d.isBreached });
  if (problems.length) throw badRequest("WEAK_PASSWORD", "Choose a stronger password", { problems });
  await req.db
    .update(schema.users)
    .set({ passwordHash: await hashPassword(password, d.argon2), mustChangePassword: false })
    .where(eq(schema.users.id, u!.id));
  await req.db.update(schema.passwordResets).set({ usedAt: now }).where(eq(schema.passwordResets.id, r.id));
  await revokeUserSessions(req.db, u!.id, "password_reset", now);
  await audit(req, {
    action: "user.password.reset",
    entityType: "user",
    entityId: u!.id,
    actorUserId: u!.id,
  });
}
