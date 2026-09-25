import { api } from "@/lib/api";
import type { Person } from "@/lib/leads/types";

export type AuditEntry = {
  id: number;
  at: string;
  actorUserId: string | null;
  actorIp: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  diff: Record<string, unknown>;
};
export type AuditQuery = { cursor?: number; actorUserId?: string; action?: string };

type Phrase = string | ((diff: Record<string, unknown>) => string);
type ActionDef = { area: string; phrase: Phrase };

const n = (v: unknown) => (typeof v === "number" ? v : 0);

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
  // Sign-in and account
  "user.login": { area: "Sign-in", phrase: "signed in" },
  "user.login.password_ok": { area: "Sign-in", phrase: "entered the right password" },
  "user.login.failed": { area: "Sign-in", phrase: "failed to sign in" },
  "user.login.locked": { area: "Sign-in", phrase: "was locked out after too many tries" },
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
  const who = e.actorUserId ? (people.find((p) => p.id === e.actorUserId)?.name ?? "Someone") : "LUME";
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
    const qs = p.toString();
    return api.get<{ entries: AuditEntry[]; nextCursor: number | null }>(
      `/api/v1/audit${qs ? `?${qs}` : ""}`,
    );
  },
};
