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

export type DigestItem = { who: string; what: string; when: string };

/**
 * The daily digest (report §10.7): lead first names and times only, never a phone number or email; every
 * item leads back into LUME, where signing in is required.
 */
export function digestMail(a: {
  to: string;
  firstName: string;
  businessName: string;
  url: string;
  overdue: DigestItem[];
  today: DigestItem[];
  assigned: number;
  admin: { unassigned: number; sources: string[] } | null;
}): OutgoingMail {
  const line = (i: DigestItem) => `${i.who}: ${i.what} (${i.when})`;
  const sections: { title: string; lines: string[] }[] = [];
  if (a.overdue.length) sections.push({ title: "Overdue", lines: a.overdue.map(line) });
  if (a.today.length) sections.push({ title: "Today", lines: a.today.map(line) });
  if (a.assigned)
    sections.push({
      title: "New for you",
      lines: [a.assigned === 1 ? "1 lead was assigned to you" : `${a.assigned} leads were assigned to you`],
    });
  if (a.admin) {
    const lines: string[] = [];
    if (a.admin.unassigned)
      lines.push(
        a.admin.unassigned === 1
          ? "1 new lead has no one yet"
          : `${a.admin.unassigned} new leads have no one yet`,
      );
    for (const s of a.admin.sources) lines.push(`${s} needs attention`);
    if (lines.length) sections.push({ title: "Needs you", lines });
  }
  const due = a.overdue.length + a.today.length;
  const subject =
    due === 0
      ? `Your day at ${a.businessName}`
      : `${due} follow-up${due === 1 ? "" : "s"} today${a.overdue.length ? `, ${a.overdue.length} overdue` : ""}`;
  const text = [
    `Good morning, ${a.firstName}.`,
    ...sections.map((s) => `\n${s.title}\n${s.lines.map((l) => `- ${l}`).join("\n")}`),
    `\nOpen Today in LUME: ${a.url}`,
  ].join("\n");
  const html = layout(
    `Good morning, ${esc(a.firstName)}`,
    sections
      .map(
        (s) =>
          `<div style="margin-top:14px;font-weight:650;color:#0A0C11">${esc(s.title)}</div>` +
          s.lines.map((l) => `<div style="margin-top:4px">${esc(l)}</div>`).join(""),
      )
      .join(""),
    { label: "Open Today", url: a.url },
  );
  return { to: a.to, subject, text, html, kind: "digest" };
}

/** A word to an admin when LUME isn't keeping a promise (3C System health): what, and where to look. */
export function opsAlertMail(a: {
  to: string;
  businessName: string;
  words: string;
  url: string;
}): OutgoingMail {
  const subject = `LUME needs a look at ${a.businessName}`;
  const text = `${a.words}

System health in LUME: ${a.url}`;
  const html = layout("LUME needs a look", esc(a.words), { label: "Open System health", url: a.url });
  return { to: a.to, subject, text, html, kind: "ops_alert" };
}
