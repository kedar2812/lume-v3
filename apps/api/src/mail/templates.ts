import type { OutgoingMail } from "./mailer";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Emails carry names and links only, never lead data (report §10.7). Plain layout that survives every client. */
function layout(title: string, body: string, cta: { label: string; url: string }): string {
  return `<!doctype html><html><body style="margin:0;background:#EEF0F3;font-family:-apple-system,Segoe UI,Inter,sans-serif;color:#0A0C11">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;padding:32px">
<tr><td style="font-weight:760;letter-spacing:.14em;font-size:15px">LUME</td></tr>
<tr><td style="padding-top:20px;font-size:20px;font-weight:650">${title}</td></tr>
<tr><td style="padding-top:10px;font-size:15px;line-height:1.5;color:#5A606D">${body}</td></tr>
<tr><td style="padding-top:24px"><a href="${esc(cta.url)}" style="display:inline-block;background:#2A5BFF;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px">${esc(cta.label)}</a></td></tr>
</table></td></tr></table></body></html>`;
}

export function inviteMail(a: {
  to: string;
  name: string;
  businessName: string;
  inviterName: string;
  url: string;
  expiresAt: Date;
}): OutgoingMail {
  const subject = `${a.inviterName} invited you to LUME for ${a.businessName}`;
  const text = `Hi ${a.name},\n\n${a.inviterName} invited you to ${a.businessName} on LUME.\n\nAccept the invite (valid for 72 hours): ${a.url}\n\nIf you weren't expecting this, you can ignore this email.`;
  const html = layout(
    `You're invited to ${esc(a.businessName)}`,
    `Hi ${esc(a.name)}, ${esc(a.inviterName)} invited you to work in LUME. The link is valid for 72 hours.`,
    { label: "Accept invite", url: a.url },
  );
  return { to: a.to, subject, text, html, kind: "invite" };
}

export function resetMail(a: { to: string; businessName: string; url: string }): OutgoingMail {
  const text = `Someone asked to reset your LUME password for ${a.businessName}.\n\nReset it here (valid for 30 minutes): ${a.url}\n\nIf this wasn't you, ignore this email; your password stays the same.`;
  return {
    to: a.to,
    subject: "Reset your LUME password",
    text,
    html: layout(
      "Reset your password",
      "This link is valid for 30 minutes. If you didn't ask for it, ignore this email.",
      { label: "Choose a new password", url: a.url },
    ),
    kind: "password_reset",
  };
}

export function lockoutMail(a: {
  to: string;
  businessName: string;
  lockedEmailHint: string;
  url: string;
}): OutgoingMail {
  const text = `An account (${a.lockedEmailHint}) at ${a.businessName} was locked for 15 minutes after repeated failed sign-ins.\n\nReview activity: ${a.url}`;
  return {
    to: a.to,
    subject: "LUME: an account was locked after failed sign-ins",
    text,
    html: layout(
      "An account was locked",
      `${esc(a.lockedEmailHint)} was locked for 15 minutes after repeated failed sign-ins.`,
      { label: "Review activity", url: a.url },
    ),
    kind: "lockout",
  };
}
