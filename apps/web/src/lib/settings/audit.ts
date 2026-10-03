import { api } from "@/lib/api";
import type { Person } from "@/lib/leads/types";

export type AuditEntry = {
  id: number;
  at: string;
  actorUserId: string | null;
  /** The actor's name, from the log itself (so reading it needs no other access). */
  actorName?: string | null;
  actorIp: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  diff: Record<string, unknown>;
};
export type AuditQuery = {
  cursor?: number;
  actorUserId?: string;
  action?: string;
  /** One day on the business's clock, YYYY-MM-DD (6C). */
  day?: string;
};

type Phrase = string | ((diff: Record<string, unknown>) => string);
type ActionDef = { area: string; phrase: Phrase };

const n = (v: unknown) => (typeof v === "number" ? v : 0);
/** The optional module an integration.enabled/disabled entry is about (2B: Google Sheets, 2C: Webhooks). */
const moduleName = (m: unknown) =>
  m === "webhooks" ? "Webhooks" : m === "google_calendar" ? "Google Calendar" : "Google Sheets";

/**
 * Every action the API records, in words ("revealed a lead's contact"), grouped by area for the filter.
 * The unit test lists every action the API writes, so a new one can't ship without its words.
 */
export const AUDIT_ACTIONS: Record<string, ActionDef> = {
  // Leads
  "lead.create": { area: "Leads", phrase: "added a lead" },
  "lead.view": { area: "Leads", phrase: "opened a lead" },
  "lead.update": { area: "Leads", phrase: "edited a lead" },
  "lead.stage": { area: "Leads", phrase: "moved a lead to another stage" },
  "lead.assign": { area: "Leads", phrase: "assigned a lead" },
  "lead.bulk": { area: "Leads", phrase: (d) => `changed ${n(d.updated)} leads at once` },
  "lead.delete": { area: "Leads", phrase: "deleted a lead" },
  "lead.contact.reveal": { area: "Leads", phrase: "revealed a lead’s contact" },
  "lead.whatsapp.prepare": { area: "Leads", phrase: "opened WhatsApp for a lead" },
  "import.started": { area: "Leads", phrase: "started an import" },
  "import.finished": {
    area: "Leads",
    phrase: (d) =>
      `imported leads: ${n(d.created)} created, ${n(d.merged)} merged, ${n(d.errors)} with problems`,
  },
  "import.cancelled": { area: "Leads", phrase: "cancelled an import" },
  "import.resumed": { area: "Leads", phrase: "resumed an import" },
  "import.stopped": { area: "Leads", phrase: "had an import stopped when their access changed" },
  "import.failed": { area: "Leads", phrase: "had an import fail" },
  "import.discarded": { area: "Leads", phrase: "discarded an import draft" },
  "integration.enabled": { area: "Settings", phrase: (d) => `switched on ${moduleName(d.module)}` },
  "integration.disabled": { area: "Settings", phrase: (d) => `switched off ${moduleName(d.module)}` },
  // The send queue (4C): a person's run through a list of leads.
  "queue.started": {
    area: "Leads",
    phrase: (d) =>
      `started a send queue of ${Number(d.leads ?? 0)} ${Number(d.leads) === 1 ? "lead" : "leads"} from “${String(d.source ?? "")}”`,
  },
  "queue.paused": { area: "Leads", phrase: "paused a send queue" },
  "queue.resumed": { area: "Leads", phrase: "resumed a send queue" },
  "queue.cancelled": {
    area: "Leads",
    phrase: (d) =>
      `ended a send queue after ${Number(d.sent ?? 0)} ${Number(d.sent) === 1 ? "message" : "messages"}`,
  },
  // Settings → Messages (4C): the run size and the daily cap, each on its own.
  "settings.messaging": {
    area: "Settings",
    phrase: (d) => {
      const size = d.queueSize === undefined ? null : `send queues to ${Number(d.queueSize)} leads a run`;
      const cap =
        d.dailyCap === undefined ? null : `the daily limit to ${Number(d.dailyCap)} queued messages a person`;
      return `set ${[size, cap].filter(Boolean).join(", and ") || "the messaging settings"}`;
    },
  },
  "settings.follow_ups": {
    area: "Settings",
    // Each part changes on its own (3B, 3C): say the ones this change touched.
    phrase: (d) => {
      const parts: string[] = [];
      const e = d.escalation as { enabled?: boolean; hours?: number } | undefined;
      if (e)
        parts.push(
          e.enabled === false
            ? "turned off escalation of overdue follow-ups"
            : `set overdue follow-ups to reach managers after ${Number(e.hours ?? 24)} hours`,
        );
      const m = d.digest as { enabled?: boolean } | undefined;
      if (m) parts.push(m.enabled ? "switched on the morning email" : "switched off the morning email");
      const q = d.noTouch as { enabled?: boolean; days?: number } | undefined;
      if (q)
        parts.push(
          q.enabled
            ? `set leads gone quiet to come back after ${Number(q.days ?? 7)} days`
            : "turned off the alert for leads gone quiet",
        );
      if (typeof d.shiftToWorkingHours === "boolean")
        parts.push(
          d.shiftToWorkingHours
            ? "kept LUME's follow-ups inside working hours"
            : "let LUME's follow-ups fall outside working hours",
        );
      if (d.duePresets) parts.push("changed the time choices");
      return parts.join("; ") || "changed the follow-up settings";
    },
  },
  "template.created": { area: "Settings", phrase: (d) => `added the template “${String(d.name ?? "")}”` },
  "template.updated": {
    area: "Settings",
    phrase: (d) =>
      d.newVersion
        ? `changed the words of “${String(d.name ?? "")}”`
        : `changed the template “${String(d.name ?? "")}”`,
  },
  "template.archived": { area: "Settings", phrase: (d) => `archived the template “${String(d.name ?? "")}”` },
  "template.reordered": { area: "Settings", phrase: () => "reordered the templates" },
  "template.restored": { area: "Settings", phrase: (d) => `put back the template “${String(d.name ?? "")}”` },
  "view.created": { area: "Leads", phrase: (d) => `saved the view “${String(d.name ?? "")}”` },
  "view.updated": { area: "Leads", phrase: (d) => `changed the view “${String(d.name ?? "")}”` },
  "view.deleted": { area: "Leads", phrase: (d) => `deleted the view “${String(d.name ?? "")}”` },
  "view.restored": { area: "Leads", phrase: (d) => `put back the view “${String(d.name ?? "")}”` },
  "stage.automations": {
    area: "Settings",
    phrase: (d) => `changed a stage's automations (${Array.isArray(d.rules) ? d.rules.length : 0})`,
  },
  "task.changed_for_other": {
    area: "Leads",
    phrase: (d) => `${String(d.what ?? "changed")} someone else's follow-up “${String(d.title ?? "")}”`,
  },
  "webhook.connected": { area: "Leads", phrase: (d) => `connected the webhook “${String(d.name ?? "")}”` },
  "webhook.mapping_changed": {
    area: "Leads",
    phrase: (d) => `changed the fields or rules of the webhook “${String(d.name ?? "")}”`,
  },
  "webhook.paused": { area: "Leads", phrase: (d) => `paused the webhook “${String(d.name ?? "")}”` },
  "webhook.resumed": { area: "Leads", phrase: (d) => `resumed the webhook “${String(d.name ?? "")}”` },
  "webhook.renamed": { area: "Leads", phrase: (d) => `renamed a webhook to “${String(d.name ?? "")}”` },
  "webhook.secret_rotated": {
    area: "Leads",
    phrase: (d) => `gave the webhook “${String(d.name ?? "")}” a new secret`,
  },
  "webhook.created": { area: "Leads", phrase: (d) => `added the webhook “${String(d.name ?? "")}”` },
  "webhook.event_retried": {
    area: "Leads",
    phrase: (d) => `retried a problem post to the webhook “${String(d.name ?? "")}”`,
  },
  "webhook.event_dismissed": {
    area: "Leads",
    phrase: (d) => `set aside a problem post to the webhook “${String(d.name ?? "")}”`,
  },
  "webhook.removed": { area: "Leads", phrase: (d) => `removed the webhook “${String(d.name ?? "")}”` },
  "sheet.connected": { area: "Leads", phrase: (d) => `connected the Google Sheet “${String(d.name ?? "")}”` },
  "sheet.mapping_changed": {
    area: "Leads",
    phrase: (d) => `changed the columns or rules of “${String(d.name ?? "")}”`,
  },
  "sheet.paused": { area: "Leads", phrase: (d) => `paused the Google Sheet “${String(d.name ?? "")}”` },
  "sheet.resumed": { area: "Leads", phrase: (d) => `resumed the Google Sheet “${String(d.name ?? "")}”` },
  "sheet.removed": { area: "Leads", phrase: (d) => `removed the Google Sheet “${String(d.name ?? "")}”` },
  "sheet.needs_attention": {
    area: "Leads",
    phrase: (d) => `paused “${String(d.name ?? "")}” until someone looks at it`,
  },
  "sheet.google_connected": {
    area: "Leads",
    phrase: (d) => `connected Google to pick “${String(d.file ?? "")}”`,
  },
  "sheet.reconnected": {
    area: "Leads",
    phrase: (d) => `connected “${String(d.name ?? "")}” to Google again`,
  },
  "calendly.connected": {
    area: "Settings",
    phrase: (d) => `connected Calendly (${String(d.account ?? "")})`,
  },
  "calendly.disconnected": { area: "Settings", phrase: "disconnected Calendly" },
  "calendly.settings_changed": { area: "Settings", phrase: "changed what Calendly bookings do" },
  "settings.calendar": {
    area: "Settings",
    phrase: (d) =>
      `changed which calendar events are meetings with leads (${n(d.titleWords)} title ${n(d.titleWords) === 1 ? "word" : "words"}, ${n(d.calendarIds)} ${n(d.calendarIds) === 1 ? "calendar" : "calendars"}${d.attendeeIsLead === false ? ", attendees off" : ""})`,
  },
  "calendar.connected": { area: "Settings", phrase: "connected their Google Calendar" },
  "calendar.reconnected": { area: "Settings", phrase: "connected their Google Calendar again" },
  "calendar.calendars_changed": {
    area: "Settings",
    phrase: (d) => `chose which calendars LUME reads (${n(d.calendars)})`,
  },
  "calendar.needs_reconnect": {
    area: "Settings",
    phrase: "found that Google stopped letting it read a calendar (it needs connecting again)",
  },
  "meeting.attached": { area: "Leads", phrase: "linked a meeting to a lead" },
  "meeting.outcome": {
    area: "Leads",
    phrase: (d) =>
      `recorded a meeting as ${d.status === "no_show" ? "a no-show" : d.status === "rescheduled" ? "rescheduled" : "held"}`,
  },
  "calendar.disconnected": {
    area: "Settings",
    phrase: (d) =>
      `disconnected their Google Calendar; LUME forgot ${n(d.meetings)} ${n(d.meetings) === 1 ? "meeting" : "meetings"}`,
  },
  "sheet.row_dismissed": {
    area: "Leads",
    phrase: (d) => `dismissed a problem row in “${String(d.name ?? "")}”`,
  },
  // Sign-in and account
  "user.login": { area: "Sign-in", phrase: "signed in" },
  "user.login.password_ok": { area: "Sign-in", phrase: "entered the right password" },
  "user.login.failed": { area: "Sign-in", phrase: "failed to sign in" },
  "user.login.locked": { area: "Sign-in", phrase: "was locked out after too many tries" },
  "user.login.suspended": { area: "Sign-in", phrase: "kept out a paused person who tried to sign in" },
  // Security (6A): what the watch did, and how admins answered
  "security.alert": { area: "Security", phrase: "raised a security alert" },
  "security.suspended": { area: "Security", phrase: "paused someone’s access" },
  "security.notified": {
    area: "Security",
    phrase: (d) => {
      const names = Array.isArray(d.names) ? (d.names as string[]) : [];
      const who =
        names.length > 1
          ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
          : (names[0] ?? "the admins");
      return `told ${who} about a security alert`;
    },
  },
  "security.restored": { area: "Security", phrase: "restored someone’s access" },
  "security.alert_resolved": {
    area: "Security",
    phrase: (d) =>
      d.resolution === "dismissed"
        ? "dismissed a security alert"
        : `answered a security alert: ${d.resolution === "kept_suspended" ? "kept them paused" : "access restored"}`,
  },
  "security.settings_changed": { area: "Security", phrase: "changed the security rules or the watermark" },
  "security.access_changed": { area: "Security", phrase: "changed when or where a role may sign in" },
  // Exports you can trace (6B)
  "lead.export": {
    area: "Leads",
    phrase: (d) =>
      `exported ${String(d.label ?? "leads")}: ${n(d.rows)} leads as ${d.format === "xlsx" ? "Excel" : "CSV"} (${String(d.code ?? "")})`,
  },
  "lead.export.download": { area: "Leads", phrase: (d) => `downloaded export ${String(d.code ?? "")}` },
  "security.trace": {
    area: "Security",
    phrase: (d) =>
      d.found ? `traced a file to export ${String(d.found)}` : "traced a file; no LUME export matched",
  },
  "user.logout": { area: "Sign-in", phrase: "signed out" },
  "user.2fa.enabled": { area: "Sign-in", phrase: "turned on two-step sign-in" },
  "user.2fa.disabled": { area: "Sign-in", phrase: "turned off two-step sign-in" },
  "user.2fa.failed": { area: "Sign-in", phrase: "entered a wrong two-step code" },
  "user.recovery_codes.regenerated": { area: "Sign-in", phrase: "made new recovery codes" },
  "user.password.reset_requested": { area: "Sign-in", phrase: "asked for a password reset" },
  "user.password.reset": { area: "Sign-in", phrase: "reset their password" },
  "session.revoked": { area: "Sign-in", phrase: "ended a session" },
  "session.revoked_all": { area: "Sign-in", phrase: "signed someone out everywhere" },
  "user.agreed": { area: "Sign-in", phrase: "agreed to the licence, terms and privacy policy" },
  "user.profile.updated": { area: "Sign-in", phrase: "updated their profile" },
  "user.onboarding.completed": { area: "Sign-in", phrase: "finished getting started" },
  // People and teams
  "user.invited": { area: "People", phrase: "invited someone" },
  "invite.resent": { area: "People", phrase: "resent an invite" },
  "invite.revoked": { area: "People", phrase: "revoked an invite" },
  "user.invite.accepted": { area: "People", phrase: "joined from an invite" },
  "user.updated": { area: "People", phrase: "changed someone’s name or role" },
  "user.disabled": { area: "People", phrase: "disabled someone" },
  // Offboarding (6C): one entry for every step.
  "user.offboarded": {
    area: "People",
    phrase: (d) => {
      const leads = (d.leads ?? {}) as { to?: string; moved?: number };
      const moved = n(leads.moved);
      const sessions = n(d.sessions);
      const parts = [
        sessions ? `${sessions} ${sessions === 1 ? "session" : "sessions"} ended` : "no sessions to end",
        moved
          ? `${moved} ${moved === 1 ? "lead" : "leads"} ${
              leads.to === "team"
                ? "shared across a team"
                : leads.to === "person"
                  ? "handed to one person"
                  : "left unassigned"
            }`
          : "no leads to hand on",
        ...(d.calendar ? ["Google Calendar disconnected"] : []),
      ];
      return `offboarded someone: ${parts.join(", ")}`;
    },
  },
  "user.enabled": { area: "People", phrase: "enabled someone again" },
  "team.created": { area: "People", phrase: "created a team" },
  "team.renamed": { area: "People", phrase: "renamed a team" },
  "team.members.set": { area: "People", phrase: "changed a team’s members" },
  "team.deleted": { area: "People", phrase: "deleted a team" },
  // Roles
  "role.created": { area: "Roles", phrase: "created a role" },
  "role.updated": { area: "Roles", phrase: "changed a role" },
  "role.field_access.updated": { area: "Roles", phrase: "changed which fields a role sees" },
  "role.deleted": { area: "Roles", phrase: "deleted a role" },
  // Settings
  "setup.completed": { area: "Settings", phrase: "finished first-run setup" },
  "settings.updated": { area: "Settings", phrase: "changed the business settings" },
  "settings.currency.changed": {
    area: "Settings",
    phrase: (d) =>
      d.from && d.to ? `changed the currency from ${d.from} to ${d.to} at ${d.rate}` : "changed the currency",
  },
  "pipeline.created": { area: "Settings", phrase: "created a pipeline" },
  "pipeline.updated": { area: "Settings", phrase: "changed a pipeline" },
  "pipeline.archived": { area: "Settings", phrase: "archived a pipeline" },
  "stage.created": { area: "Settings", phrase: "added a stage" },
  "stage.updated": { area: "Settings", phrase: "changed a stage" },
  "stage.reordered": { area: "Settings", phrase: "reordered the stages" },
  "stage.archived": { area: "Settings", phrase: "archived a stage" },
  "field.created": { area: "Settings", phrase: "added a field" },
  "field.updated": { area: "Settings", phrase: "changed a field" },
  "field.archived": { area: "Settings", phrase: "archived a field" },
  "lost_reason.created": { area: "Settings", phrase: "added a lost reason" },
  "lost_reason.updated": { area: "Settings", phrase: "changed a lost reason" },
  "lost_reason.reordered": { area: "Settings", phrase: "reordered the lost reasons" },
  "lost_reason.archived": { area: "Settings", phrase: "archived a lost reason" },
  "tag.created": { area: "Settings", phrase: "added a tag" },
  "tag.updated": { area: "Settings", phrase: "changed a tag" },
  "tag.deleted": { area: "Settings", phrase: "removed a tag" },
  "product.created": { area: "Settings", phrase: "added a package" },
  "product.updated": { area: "Settings", phrase: "changed a package" },
  "product.archived": { area: "Settings", phrase: "archived a package" },
};

/** "Riya Sharma revealed a lead's contact": who (LUME for the system itself), then what, in words. */
export function auditPhrase(e: AuditEntry, people: Person[]): string {
  const who = e.actorUserId
    ? (e.actorName ?? people.find((p) => p.id === e.actorUserId)?.name ?? "Someone")
    : "LUME";
  const def = AUDIT_ACTIONS[e.action];
  if (!def) return `${who}: ${e.action}`;
  return `${who} ${typeof def.phrase === "function" ? def.phrase(e.diff ?? {}) : def.phrase}`;
}

/** The audit log is read-only: this is the only call. */
export const auditClient = {
  list: (q: AuditQuery) => {
    const p = new URLSearchParams();
    if (q.cursor) p.set("cursor", String(q.cursor));
    if (q.actorUserId) p.set("actorUserId", q.actorUserId);
    if (q.action) p.set("action", q.action);
    if (q.day) p.set("day", q.day);
    const qs = p.toString();
    return api.get<{ entries: AuditEntry[]; nextCursor: number | null }>(
      `/api/v1/audit${qs ? `?${qs}` : ""}`,
    );
  },
};
