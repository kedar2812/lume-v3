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
      /** LUME may add LUME AI's calls to this calendar, with a Meet link (spec 2026-11-03). */
      addsEvents: boolean;
      calendars: { id: string; name: string; chosen: boolean }[];
      lastSyncedAt: string | null;
      lastSync: LastSync | null;
      lastError: string | null;
      /** When the latest sync failed (null once one succeeds after it, or never failed). */
      lastFailedAt: string | null;
      /** How far a running sync has got: reading calendar `done` of `total`, then saving (null between syncs). */
      syncProgress?: { stage: "reading" | "saving"; done: number; total: number } | null;
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
  matchedBy: "attendee" | "title" | "calendar" | "calendly" | "lume_ai" | "lume" | "person";
  /** Where it lives: Google Calendar, Calendly, or LUME's own calls (on Google with a Meet link). */
  source?: "google" | "calendly" | "lume";
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
  /** The links whose bookings are leads' (event type URIs); null or missing: every link. */
  links?: string[] | null;
  /** LUME's booking link, the one it books calls on. */
  bookWith?: string | null;
};

/** One of the Calendly account's scheduling links, for Settings (owner 2026-11-27). */
export type CalendlyLink = {
  uri: string;
  name: string;
  duration: number;
  schedulingUrl: string;
  owner: string | null;
  /** Its bookings come into LUME. */
  forLeads: boolean;
  /** LUME can book calls on it; otherwise why not. */
  bookable: boolean;
  why?: string;
};
export type CalendlyLinks = {
  every: boolean;
  /** The links saved; one Calendly didn't list this time stays saved. */
  saved?: string[] | null;
  bookWith: string | null;
  links: CalendlyLink[];
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

/** Schedule a meeting (2026-11-13): whether this person can now, and why not in words. */
export type ScheduleReady =
  { ready: true } | { ready: false; why: "off" | "connect" | "permission" | "reconnect"; message: string };

/** A meeting just scheduled: it, its Meet link, its time in words, the WhatsApp message, and how that can go. */
export type Scheduled = {
  meeting: Meeting;
  link: string;
  label: string;
  message: string;
  whatsapp: { send: boolean; why: string | null; open: boolean };
};

/** Booking on Calendly (owner 2026-11-27): ready or why not, in words, and the link's free start times. */
export type CalendlyReady =
  /** `link` is null when only LUME's settings were read (no lead chosen yet: Calendly isn't asked). */
  | { ready: true; link: { name: string; duration: number } | null }
  | {
      ready: false;
      why: "off" | "no_link" | "link_gone" | "not_bookable" | "no_email" | "no_phone";
      message: string;
    };
export type CalendlyOptions = {
  ready: CalendlyReady;
  times: string[];
  /** A lead Calendly can't book (no email): the link's page to send instead, a message ready, and WhatsApp's way. */
  send?: { url: string; message: string; whatsapp: Scheduled["whatsapp"] };
};
export type CalendlyScheduled = { meeting: Meeting; label: string };
