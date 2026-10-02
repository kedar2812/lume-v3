import type { CalendarRules } from "@lume/core/shared";

/** What the last sync changed (5D Task 2), for Refresh to say. */
export type LastSync = { at: string; added: number; moved: number; cancelled: number; changed: number };

/** A person's own Google Calendar connection: never the grant, never a sync token. */
export type CalendarConnection =
  | { available: boolean; connected: false }
  | {
      available: boolean;
      connected: true;
      googleEmail: string;
      status: "active" | "needs_reconnect";
      calendars: { id: string; name: string; chosen: boolean }[];
      lastSyncedAt: string | null;
      lastSync: LastSync | null;
      lastError: string | null;
    };

/** Refresh's answer: wait for a `lastSync.at` newer than `since`. */
export type SyncQueued = { queued: true; since: string };

export type MeetingStatus = "scheduled" | "cancelled" | "completed" | "no_show" | "rescheduled";
export type MeetingOutcome = "completed" | "no_show" | "rescheduled";

export type Meeting = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: MeetingStatus;
  link: string | null;
  location: string | null;
  ownerId: string;
  matchedBy: "attendee" | "title" | "calendar" | "calendly";
  outcomeNote: string | null;
  lead: { id: string; name: string; pipelineId: string; stageId: string } | null;
};

export type MeetingsQuery = {
  from: Date;
  to: Date;
  ownerId?: string;
  pipelineId?: string;
  stageId?: string;
};

export type MeetingPatch = { leadId?: string; status?: MeetingOutcome; outcomeNote?: string | null };

export type CalendlySettings = {
  createLeads: boolean;
  rescheduleFollowUp: boolean;
  phoneQuestion: string | null;
};

/** Settings → Integrations → Calendly: never the token or the signing key. */
export type CalendlyView =
  | { connected: false }
  | {
      connected: true;
      account: { name: string; email: string };
      scope: "organization" | "user";
      status: "active" | "paused" | "needs_attention";
      settings: CalendlySettings;
      lastEventAt: string | null;
      lastError: string | null;
      runAs: { id: string; name: string } | null;
    };

export type { CalendarRules };
