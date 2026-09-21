import type { FastifyRequest } from "fastify";
import nodemailer from "nodemailer";

export type OutgoingMail = {
  to: string;
  subject: string;
  text: string;
  html: string;
  kind: "invite" | "password_reset" | "lockout";
};
export type Mailer = { send(m: OutgoingMail): Promise<void> };

/** Without SMTP_URL mail is not sent (nothing sensitive is logged); invite links are still shown to the admin. */
export function createMailer(smtpUrl: string | undefined, from: string): Mailer {
  if (!smtpUrl) {
    return {
      send: async (m) =>
        console.warn(JSON.stringify({ level: "warn", msg: "mail not configured", kind: m.kind })),
    };
  }
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    send: async (m) => {
      await transport.sendMail({ from, to: m.to, subject: m.subject, text: m.text, html: m.html });
    },
  };
}

/**
 * Send once the request's transaction has committed, without waiting for it. A slow or failing mail
 * server can neither roll back the change nor change the response (which would leak, for example,
 * whether a password-reset address exists). Failures are logged by kind only.
 */
export function sendAfterCommit(req: FastifyRequest, mailer: Mailer, mail: OutgoingMail): void {
  req.afterCommit(() => {
    mailer.send(mail).catch((err: unknown) => {
      req.log.error(
        { kind: mail.kind, err: err instanceof Error ? err.message : String(err) },
        "mail send failed",
      );
    });
  });
}
