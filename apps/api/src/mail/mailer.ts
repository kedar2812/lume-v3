import nodemailer from "nodemailer";

export type OutgoingMail = {
  to: string;
  subject: string;
  text: string;
  html: string;
  kind: "invite" | "password_reset" | "lockout";
};
export type Mailer = { send(m: OutgoingMail): Promise<void> };

/** Without SMTP_URL mail is not sent (and nothing sensitive is logged); invite links are still shown to the admin. */
export function createMailer(smtpUrl: string | undefined, from: string): Mailer {
  if (!smtpUrl)
    return {
      send: async (m) =>
        console.warn(JSON.stringify({ level: "warn", msg: "mail not configured", kind: m.kind })),
    };
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    send: async (m) => {
      await transport.sendMail({ from, to: m.to, subject: m.subject, text: m.text, html: m.html });
    },
  };
}
