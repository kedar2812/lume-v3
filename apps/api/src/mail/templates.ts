import { greetingAt } from "@lume/core";
import type { OutgoingMail } from "./mailer";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/*
 * LUME's emails (owner, 2026-10-19: "official", never AI slop). One family, the app's own look: the Porcelain canvas,
 * one white sheet, Inter, one solid blue (#2A5BFF), and colour only where it means something (red overdue, amber due
 * today, blue new, green done). No gradients, glows or shouting capitals. Tables and inline styles, so Gmail, Outlook
 * and Apple Mail draw it the same; Apple Mail and iOS also get Carbon in dark mode. Emails carry names and links
 * only, never a lead's number or address (report §10.7).
 */
const C = {
  canvas: "#EEF0F3",
  sheet: "#FFFFFF",
  line: "#E4E7EC",
  panel: "#F5F6F8",
  ink: "#0A0C11",
  body: "#3D4250",
  muted: "#6B7180",
  blue: "#2A5BFF",
  red: "#C62A30",
  amber: "#A15C00",
  green: "#0F7F44",
  grey: "#9AA0AC",
} as const;
// Single quotes only: this sits inside style="…" attributes, where a double quote would end the attribute.
const FONT = `Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

/** Dark mode where the mail app honours it (Apple Mail, iOS, Outlook.com): LUME's Carbon, and the same blue. */
const DARK = `
:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme:dark){
.l-canvas{background:#141518!important}
.l-sheet{background:#212328!important;border-color:#2B2E34!important}
.l-panel{background:#2B2E34!important}
.l-ink{color:#F2F3F5!important}
.l-body{color:#C9CCD3!important}
.l-muted{color:#9297A0!important}
.l-line{border-color:#2B2E34!important}
.l-panel .l-line{border-color:#3A3D44!important}
.l-link{color:#8AA7FF!important}
}
@media only screen and (max-width:520px){
.l-pad{padding:28px 22px!important}
.l-h1{font-size:24px!important}
}`;

type Shell = {
  /** The line mail apps show beside the subject. */
  preheader: string;
  /** Where the LUME it came from lives: the logo and the footer link are this server's own. */
  origin: string | null;
  businessName: string;
  body: string;
  /** Why this person got it, in a line, under the sheet. */
  why: string;
};

/** The frame every LUME email shares: the canvas, the mark and the business, the sheet, and a quiet footer. */
function shell(s: Shell): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>LUME</title><style>${DARK}</style></head>
<body class="l-canvas" style="margin:0;padding:0;background:${C.canvas};-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(s.preheader)}${"&#8199;&#65279;&#847;".repeat(30)}</div>
<table role="presentation" class="l-canvas" width="100%" cellpadding="0" cellspacing="0" style="background:${C.canvas}">
<tr><td align="center" style="padding:36px 12px 28px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 6px 18px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="vertical-align:middle">${
    s.origin
      ? `<img src="${esc(s.origin)}/lume-mark.png" width="28" height="28" alt="LUME" style="display:block;border:0;border-radius:7px">`
      : `<span class="l-ink" style="font:700 15px/1 ${FONT};letter-spacing:0.08em;color:${C.ink}">LUME</span>`
  }</td>
<td align="right" class="l-muted" style="vertical-align:middle;font:500 13px/1.3 ${FONT};color:${C.muted}">${esc(s.businessName)}</td>
</tr></table></td></tr>
<tr><td class="l-sheet l-pad" style="background:${C.sheet};border:1px solid ${C.line};border-radius:20px;padding:36px 36px 34px;box-shadow:0 1px 2px rgba(10,12,17,.04),0 8px 24px rgba(10,12,17,.06)">
${s.body}
</td></tr>
<tr><td class="l-muted" style="padding:20px 8px 0;font:400 12px/1.6 ${FONT};color:${C.muted}">
${s.why}<br>Sent by LUME for ${esc(s.businessName)}${
    s.origin
      ? ` · <a class="l-link" href="${esc(s.origin)}" style="color:${C.muted};text-decoration:underline">${esc(s.origin.replace(/^https?:\/\//, ""))}</a>`
      : ""
  }
</td></tr>
</table></td></tr></table></body></html>`;
}

const h1 = (t: string) =>
  `<div class="l-ink l-h1" style="font:700 28px/1.18 ${FONT};letter-spacing:-0.02em;color:${C.ink}">${t}</div>`;
const p = (t: string, top = 12) =>
  `<div class="l-body" style="padding-top:${top}px;font:400 16px/1.55 ${FONT};color:${C.body}">${t}</div>`;
const small = (t: string, top = 16) =>
  `<div class="l-muted" style="padding-top:${top}px;font:400 13px/1.55 ${FONT};color:${C.muted}">${t}</div>`;

/** A button every client draws, Outlook included: a table cell, not a styled link alone. */
function button(label: string, url: string, top = 28): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:${top}px"><tr>
<td style="background:${C.blue};border-radius:12px"><a href="${esc(url)}" style="display:inline-block;padding:15px 26px;font:600 16px/1 ${FONT};color:#FFFFFF;text-decoration:none;border-radius:12px">${esc(label)}</a></td>
</tr></table>`;
}

/** For when the button won't open: the link itself, to copy. */
const linkLine = (url: string) =>
  small(
    `Button not working? Paste this into your browser:<br><a class="l-link" href="${esc(url)}" style="color:${C.blue};text-decoration:none;word-break:break-all">${esc(url)}</a>`,
    24,
  );

/** Facts in a soft panel: label on the left, the value on the right. */
function facts(rows: { label: string; value: string }[]): string {
  return `<table role="presentation" class="l-panel" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;background:${C.panel};border-radius:14px">
${rows
  .map(
    (
      r,
      i,
    ) => `<tr><td class="l-muted${i ? " l-line" : ""}" style="padding:12px 16px;white-space:nowrap;font:400 14px/1.4 ${FONT};color:${C.muted};${i ? `border-top:1px solid ${C.line}` : ""}">${esc(r.label)}</td>
<td align="right" class="l-ink${i ? " l-line" : ""}" style="padding:12px 16px;word-break:break-word;font:600 14px/1.4 ${FONT};color:${C.ink};${i ? `border-top:1px solid ${C.line}` : ""}">${esc(r.value)}</td></tr>`,
  )
  .join("\n")}
</table>`;
}

/** A person's initials on one of LUME's avatar colours, beside a line about them. */
function person(name: string, line: string): string {
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?";
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:20px"><tr>
<td style="width:36px;vertical-align:top"><div style="width:36px;height:36px;background:${C.blue};border-radius:18px;text-align:center;font:600 13px/36px ${FONT};color:#FFFFFF">${esc(initials)}</div></td>
<td class="l-body" style="padding-left:12px;vertical-align:middle;font:400 15px/1.45 ${FONT};color:${C.body}">${line}</td>
</tr></table>`;
}

type Tone = "red" | "amber" | "blue" | "green" | "grey";
/** A row; one without a tone is a quiet line (the "and 2 more" after a list), with no dot. */
type Row = { tone: Tone | null; title: string; meta?: string; url?: string };

/** One section of a list: a title, then rows, each with a dot that says what kind of thing it is. */
function list(title: string, rows: Row[]): string {
  const row = (r: Row, i: number) => {
    const name = r.url
      ? `<a class="l-ink" href="${esc(r.url)}" style="color:${C.ink};text-decoration:none">${esc(r.title)}</a>`
      : esc(r.title);
    return `<tr><td class="${i ? "l-line" : ""}" style="width:18px;padding:11px 0;vertical-align:top;${i ? `border-top:1px solid ${C.line}` : ""}">${r.tone ? `<div style="width:8px;height:8px;margin-top:6px;border-radius:4px;background:${C[r.tone]}"></div>` : ""}</td>
<td class="${r.tone ? "l-ink" : "l-muted"}${i ? " l-line" : ""}" style="padding:11px 0;font:${r.tone ? 500 : 400} 15px/1.45 ${FONT};color:${r.tone ? C.ink : C.muted};${i ? `border-top:1px solid ${C.line}` : ""}">${name}</td>
<td align="right" class="l-muted${i ? " l-line" : ""}" style="padding:11px 0 11px 12px;white-space:nowrap;font:400 13px/1.45 ${FONT};color:${C.muted};${i ? `border-top:1px solid ${C.line}` : ""}">${r.meta ? esc(r.meta) : ""}</td></tr>`;
  };
  return `<div class="l-ink" style="padding-top:28px;font:600 13px/1.3 ${FONT};color:${C.ink}">${esc(title)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px">${rows.map(row).join("")}</table>`;
}

/** Up to three numbers side by side; a number that needs attention takes its colour, a zero stays grey. */
function stats(items: { n: number; label: string; tone: Tone }[]): string {
  const cell = (s: (typeof items)[number], i: number) =>
    `<td class="l-panel l-stat" width="${Math.floor(100 / items.length)}%" style="background:${C.panel};border-radius:14px;padding:14px 16px;${i ? "" : ""}">
<div style="font:700 26px/1.1 ${FONT};letter-spacing:-0.02em;color:${s.n ? C[s.tone] : C.grey}">${s.n}</div>
<div class="l-muted" style="padding-top:4px;font:500 13px/1.3 ${FONT};color:${C.muted}">${esc(s.label)}</div></td>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;border-collapse:separate;border-spacing:0">
<tr>${items.map((s, i) => (i ? `<td style="width:8px;font-size:0">&nbsp;</td>` : "") + cell(s, i)).join("")}</tr></table>`;
}

/** This LUME's own address, from a link it sent; null when the link isn't a full address (no public URL set). */
const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/** "Thursday, October 22 at 4:12 pm", on the business's clock (month first, the owner's rule). */
function whenWords(d: Date, tz = "UTC"): string {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })
    .format(d)
    .toLowerCase();
  return `${day} at ${time}`;
}

export function inviteMail(a: {
  to: string;
  name: string;
  businessName: string;
  inviterName: string;
  url: string;
  expiresAt: Date;
  /** The roles they'll have, by name (Admin, Sales). */
  roleNames?: string[];
  /** The business's timezone, for when the link stops working. */
  tz?: string;
}): OutgoingMail {
  const subject = `${a.inviterName} invited you to LUME for ${a.businessName}`;
  const role = a.roleNames?.length ? a.roleNames.join(", ") : null;
  const until = whenWords(a.expiresAt, a.tz);
  const text = `Hi ${a.name},\n\n${a.inviterName} invited you to ${a.businessName} on LUME${role ? ` as ${role}` : ""}.\n\nAccept the invite (it works until ${until}): ${a.url}\n\nIf you weren't expecting this, you can ignore this email. Nothing happens until the invite is accepted.`;
  const html = shell({
    preheader: `${a.inviterName} added you to ${a.businessName}. The invite works for 72 hours.`,
    origin: originOf(a.url),
    businessName: a.businessName,
    body:
      h1(`Join ${esc(a.businessName)} on LUME`) +
      person(
        a.inviterName,
        `<b class="l-ink" style="color:${C.ink};font-weight:600">${esc(a.inviterName)}</b> invited you, ${esc(a.name)}, to work with the team in LUME: every lead, follow-up and message in one place.`,
      ) +
      facts([
        { label: "Team", value: a.businessName },
        ...(role ? [{ label: "Your role", value: role }] : []),
        { label: "You sign in with", value: a.to },
        { label: "Invite works until", value: until },
      ]) +
      button("Accept invite", a.url) +
      small("You'll choose your password next. It takes a minute.", 14) +
      linkLine(a.url),
    why: "Not expecting this? Ignore it. Nothing happens until the invite is accepted.",
  });
  return { to: a.to, subject, text, html, kind: "invite" };
}

export function resetMail(a: { to: string; businessName: string; url: string }): OutgoingMail {
  const text = `Someone asked to reset your LUME password for ${a.businessName}.\n\nReset it here (valid for 30 minutes): ${a.url}\n\nIf this wasn't you, ignore this email; your password stays the same.`;
  return {
    to: a.to,
    subject: "Reset your LUME password",
    text,
    html: shell({
      preheader: "Your link to choose a new password. It works for 30 minutes.",
      origin: originOf(a.url),
      businessName: a.businessName,
      body:
        h1("Choose a new password") +
        p(
          `Someone asked to reset the password for <b class="l-ink" style="color:${C.ink};font-weight:600">${esc(a.to)}</b> at ${esc(a.businessName)}. The link works for 30 minutes, once.`,
        ) +
        button("Choose a new password", a.url) +
        linkLine(a.url),
      why: "Didn't ask for this? Ignore it. Your password stays the same.",
    }),
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
    html: shell({
      preheader: `${a.lockedEmailHint} was locked for 15 minutes after repeated failed sign-ins.`,
      origin: originOf(a.url),
      businessName: a.businessName,
      body:
        `<div style="font:600 13px/1.3 ${FONT};color:${C.red}">Security</div>` +
        `<div style="padding-top:8px">${h1("An account was locked")}</div>` +
        p(
          `<b class="l-ink" style="color:${C.ink};font-weight:600">${esc(a.lockedEmailHint)}</b> was locked for 15 minutes after repeated failed sign-ins. If that wasn't them, someone may be guessing the password.`,
        ) +
        button("Review activity", a.url),
      why: "You get this because you look after security for this team.",
    }),
    kind: "lockout",
  };
}

export type DigestItem = { who: string; what: string; when: string; url?: string };

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
  /** The leads assigned (first names, each with its link), the first few of `assigned`. */
  assignedLeads?: { who: string; url: string }[];
  admin: { unassigned: number; sources: string[]; securityAlerts?: number } | null;
  /** The hour it goes, on the person's clock: a late one isn't "Good morning". */
  localHour?: number;
  /** Their day, in words ("Monday, October 19"), for the top of the email. */
  day?: string;
}): OutgoingMail {
  type Line = { text: string; url?: string };
  const line = (i: DigestItem): Line => ({
    text: `${i.who}: ${i.what} (${i.when})`,
    ...(i.url ? { url: i.url } : {}),
  });
  const sections: { title: string; lines: Line[]; rows: Row[] }[] = [];
  const itemRow =
    (tone: Tone) =>
    (i: DigestItem): Row => ({
      tone,
      title: `${i.who} · ${i.what}`,
      meta: i.when,
      ...(i.url ? { url: i.url } : {}),
    });
  if (a.overdue.length)
    sections.push({ title: "Overdue", lines: a.overdue.map(line), rows: a.overdue.map(itemRow("red")) });
  if (a.today.length)
    sections.push({ title: "Today", lines: a.today.map(line), rows: a.today.map(itemRow("amber")) });
  if (a.assigned) {
    const named = a.assignedLeads ?? [];
    const rest = a.assigned - named.length;
    const lines: Line[] = named.length
      ? [
          ...named.map((l) => ({ text: l.who, url: l.url })),
          ...(rest > 0 ? [{ text: `and ${rest} more` }] : []),
        ]
      : [
          {
            text:
              a.assigned === 1 ? "1 lead was assigned to you" : `${a.assigned} leads were assigned to you`,
          },
        ];
    sections.push({
      title: "New for you",
      lines,
      // A named lead takes the blue dot; "and 2 more" is a quiet line.
      rows: lines.map((l) => ({
        tone: l.url || !named.length ? ("blue" as const) : null,
        title: l.text,
        ...(l.url ? { url: l.url } : {}),
      })),
    });
  }
  if (a.admin) {
    const rows: Row[] = [];
    const n = a.admin.securityAlerts ?? 0;
    // First: someone may be taking lead data (6A). Links to Settings → Security, where it's reviewed.
    if (n)
      rows.push({
        tone: "red",
        title: n === 1 ? "1 security alert needs you" : `${n} security alerts need you`,
        url: `${new URL(a.url).origin}/settings/security`,
      });
    if (a.admin.unassigned)
      rows.push({
        tone: "amber",
        title:
          a.admin.unassigned === 1
            ? "1 new lead has no one yet"
            : `${a.admin.unassigned} new leads have no one yet`,
      });
    for (const s of a.admin.sources) rows.push({ tone: "amber", title: `${s} needs attention` });
    if (rows.length)
      sections.push({
        title: "Needs you",
        lines: rows.map((r) => ({ text: r.title, ...(r.url ? { url: r.url } : {}) })),
        rows,
      });
  }
  const due = a.overdue.length + a.today.length;
  const subject =
    due === 0
      ? `Your day at ${a.businessName}`
      : `${due} follow-up${due === 1 ? "" : "s"} today${a.overdue.length ? `, ${a.overdue.length} overdue` : ""}`;
  const hour = a.localHour ?? 8;
  const greeting = greetingAt(hour);
  const text = [
    `${greeting}, ${a.firstName}.`,
    ...sections.map(
      (s) => `\n${s.title}\n${s.lines.map((l) => `- ${l.text}${l.url ? ` ${l.url}` : ""}`).join("\n")}`,
    ),
    `\nOpen Today in LUME: ${a.url}`,
  ].join("\n");
  const summary =
    due === 0
      ? "Nothing is due today."
      : `${due} follow-up${due === 1 ? "" : "s"} today${a.overdue.length ? `, ${a.overdue.length} of them overdue` : ""}.`;
  const html = shell({
    preheader: `${summary} Your day at ${a.businessName}.`,
    origin: originOf(a.url),
    businessName: a.businessName,
    body:
      (a.day
        ? `<div class="l-muted" style="padding-bottom:6px;font:500 13px/1.3 ${FONT};color:${C.muted}">${esc(a.day)}</div>`
        : "") +
      h1(`${greeting}, ${esc(a.firstName)}`) +
      p(esc(summary), 8) +
      stats([
        { n: a.overdue.length, label: "Overdue", tone: "red" },
        { n: a.today.length, label: "Due today", tone: "amber" },
        { n: a.assigned, label: "New for you", tone: "blue" },
      ]) +
      sections.map((s) => list(s.title, s.rows)).join("") +
      button("Open Today", a.url, 30),
    why: "Your morning email from LUME, on your working days. Change it in LUME, under Settings, then My account.",
  });
  return { to: a.to, subject, text, html, kind: "digest" };
}

/**
 * Monday's look at last week (8B, spec §5.3), for people who see all analytics: numbers only, each against the
 * week before by the owner's trend rule; who won the most, where most leads stopped, what's overdue, and the top
 * thing LUME noticed. Never a lead's name, number or address: these are aggregates, and the email leaves LUME.
 */
export function weeklyAnalyticsMail(a: {
  to: string;
  firstName: string;
  businessName: string;
  url: string;
  week: string;
  tiles: string[];
  topPerson: string | null;
  dropStage: string | null;
  overdue: number;
  insight: { title: string; body: string } | null;
}): OutgoingMail {
  const lines = [
    ...a.tiles,
    ...(a.topPerson ? [a.topPerson] : []),
    ...(a.dropStage ? [a.dropStage] : []),
    a.overdue
      ? `${a.overdue} follow-up${a.overdue === 1 ? " is" : "s are"} overdue now`
      : "No follow-ups are overdue",
  ];
  const subject = `Last week at ${a.businessName}: ${a.tiles[0] ?? "your numbers"}`;
  const text = [
    `Good morning, ${a.firstName}. Here's ${a.week}.`,
    "",
    ...lines.map((l) => `- ${l}`),
    ...(a.insight ? ["", `LUME noticed: ${a.insight.title}. ${a.insight.body}`] : []),
    "",
    `Open Analytics in LUME: ${a.url}`,
  ].join("\n");
  const rows: Row[] = [
    ...a.tiles.map((t) => ({ tone: "blue" as const, title: t })),
    ...(a.topPerson ? [{ tone: "green" as const, title: a.topPerson }] : []),
    ...(a.dropStage ? [{ tone: "amber" as const, title: a.dropStage }] : []),
    a.overdue
      ? {
          tone: "red" as const,
          title: `${a.overdue} follow-up${a.overdue === 1 ? " is" : "s are"} overdue now`,
        }
      : { tone: "green" as const, title: "No follow-ups are overdue" },
  ];
  const html = shell({
    preheader: `${a.tiles[0] ?? "Your numbers"}. Last week at ${a.businessName}.`,
    origin: originOf(a.url),
    businessName: a.businessName,
    body:
      `<div class="l-muted" style="padding-bottom:6px;font:500 13px/1.3 ${FONT};color:${C.muted}">${esc(a.week.replace(/^last week \(|\)$/g, ""))}</div>` +
      h1(`Last week at ${esc(a.businessName)}`) +
      p(`Good morning, ${esc(a.firstName)}. Here's how the week went.`, 10) +
      list("The numbers", rows) +
      (a.insight
        ? `<table role="presentation" class="l-panel" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;background:${C.panel};border-radius:14px"><tr>
<td style="padding:16px 18px"><div class="l-link" style="font:600 13px/1.3 ${FONT};color:${C.blue}">LUME noticed</div>
<div class="l-ink" style="padding-top:6px;font:600 15px/1.4 ${FONT};color:${C.ink}">${esc(a.insight.title)}</div>
<div class="l-body" style="padding-top:4px;font:400 14px/1.55 ${FONT};color:${C.body}">${esc(a.insight.body)}</div></td></tr></table>`
        : "") +
      button("Open Analytics", a.url, 30),
    why: "Every Monday, for the people who see this team's analytics.",
  });
  return { to: a.to, subject, text, html, kind: "weekly_analytics" };
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
  const html = shell({
    preheader: a.words,
    origin: originOf(a.url),
    businessName: a.businessName,
    body:
      `<div style="font:600 13px/1.3 ${FONT};color:${C.amber}">System health</div>` +
      `<div style="padding-top:8px">${h1("LUME needs a look")}</div>` +
      p(esc(a.words)) +
      button("Open System health", a.url),
    why: "You get this because you look after this LUME.",
  });
  return { to: a.to, subject, text, html, kind: "ops_alert" };
}
