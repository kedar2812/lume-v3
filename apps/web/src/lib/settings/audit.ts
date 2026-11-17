import { AUDIT_ACTIONS, auditWords } from "@lume/core/shared";
import { api } from "@/lib/api";
import type { Person } from "@/lib/leads/types";

export { AUDIT_ACTIONS };

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

/** "Riya Sharma revealed a lead's contact": who (LUME for the system itself), then what, in words. */
export function auditPhrase(e: AuditEntry, people: Person[]): string {
  const who = e.actorUserId
    ? (e.actorName ?? people.find((p) => p.id === e.actorUserId)?.name ?? "Someone")
    : "LUME";
  const words = auditWords(e.action, e.diff);
  return words === null ? `${who}: ${e.action}` : `${who} ${words}`;
}

const params = (q: AuditQuery) => {
  const p = new URLSearchParams();
  if (q.cursor) p.set("cursor", String(q.cursor));
  if (q.actorUserId) p.set("actorUserId", q.actorUserId);
  if (q.action) p.set("action", q.action);
  if (q.day) p.set("day", q.day);
  const qs = p.toString();
  return qs ? `?${qs}` : "";
};

/** The audit log is read-only: reading it, and downloading it with the same filters. */
export const auditClient = {
  list: (q: AuditQuery) =>
    api.get<{ entries: AuditEntry[]; nextCursor: number | null }>(`/api/v1/audit${params(q)}`),
  /** The password buys a ticket for one download (owner 2026-11-17: the password, not two-step sign-in). */
  csvTicket: (password: string) => api.post<{ ticket: string }>("/api/v1/audit/csv/ticket", { password }),
  /** Every entry these filters match, as a CSV (owner 2026-11-14); the page's own cursor never goes with it. */
  csvHref: (q: AuditQuery, ticket?: string) => {
    const qs = params({ ...q, cursor: undefined });
    return `/api/v1/audit/csv${qs}${ticket ? `${qs ? "&" : "?"}ticket=${encodeURIComponent(ticket)}` : ""}`;
  },
};
