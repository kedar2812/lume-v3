import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { lockoutMail } from "../../mail/templates";
import { sendAfterCommit } from "../../mail/mailer";
import type { LockoutHook } from "./service";

/** "t•••@nupuur.com": enough for an admin to recognise the account, useless to anyone else. */
export function emailHint(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}•••@${domain}`;
}

/**
 * Report §12.1: a lockout alerts the owner and everyone who can manage security. Unknown emails lock
 * too (so attackers learn nothing) but alert no one — there is no account to protect.
 */
export function lockoutAlerts(d: Pick<AppDeps, "mailer" | "config">): LockoutHook {
  return async (req: FastifyRequest, lockedUserId) => {
    if (!lockedUserId) return;
    const locked = await req.db.execute<{ email: string }>(
      sql`SELECT email FROM users WHERE id = ${lockedUserId}`,
    );
    const lockedEmail = locked.rows[0]?.email;
    if (!lockedEmail) return;
    const recipients = await req.db.execute<{ email: string }>(sql`
      SELECT DISTINCT u.email FROM users u
       WHERE u.status = 'active' AND (
         u.is_owner OR EXISTS (
           SELECT 1 FROM user_roles ur
             JOIN roles r ON r.id = ur.role_id AND r.deleted_at IS NULL
             JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission_key = 'security.manage'
            WHERE ur.user_id = u.id))`);
    const [s] = await req.db.select({ name: schema.settings.businessName }).from(schema.settings);
    for (const { email } of recipients.rows) {
      sendAfterCommit(
        req,
        d.mailer,
        lockoutMail({
          to: email,
          businessName: s?.name ?? "LUME",
          lockedEmailHint: emailHint(lockedEmail),
          url: `${d.config.publicUrl}/settings/security`,
        }),
      );
    }
  };
}
