import { sql } from "drizzle-orm";
import { integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { bytea, tz } from "./types";

/** One chosen-or-not calendar of a connection, with how far LUME has read it. */
export type ConnectedCalendar = {
  id: string;
  name: string;
  chosen: boolean;
  syncToken?: string | null;
  /** When LUME last read its whole window (ISO): once a day, so a lead's new email still finds old events. */
  fullAt?: string | null;
};
/** What one sync changed: meetings added, moved, cancelled (or gone), and otherwise changed. */
export type LastSync = { at: string; added: number; moved: number; cancelled: number; changed: number };
export type MeetingStatus = "scheduled" | "cancelled" | "completed" | "no_show" | "rescheduled";

/** A person's Google Calendar, connected through the relay (Phase 5A). Their own row only. */
export const calendarConnections = pgTable("calendar_connections", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().unique("calendar_connections_one"),
  googleEmail: text("google_email").notNull(),
  /** Sealed with the instance keyring, bound to `calendar-connection:<id>`. */
  grantEnc: bytea("grant_enc").notNull(),
  calendars: jsonb("calendars")
    .$type<ConnectedCalendar[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  status: text("status").$type<"active" | "needs_reconnect">().notNull().default("active"),
  lastSyncedAt: tz("last_synced_at"),
  /** What the latest sync changed (5D Refresh); `at` is when it started reading. */
  lastSync: jsonb("last_sync").$type<LastSync>(),
  /** The latest Refresh: a sync that started before it leaves the connection due at once. */
  syncRequestedAt: tz("sync_requested_at"),
  nextSyncAt: tz("next_sync_at").notNull().defaultNow(),
  failures: integer("failures").notNull().default(0),
  lastError: text("last_error"),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

/** A meeting with a lead (or, unlinked, one a rule kept for its owner to attach). Seen as its lead is. */
export const meetings = pgTable(
  "meetings",
  {
    id: uuid("id").primaryKey(),
    leadId: uuid("lead_id"),
    ownerId: uuid("owner_id").notNull(),
    connectionId: uuid("connection_id"),
    source: text("source").$type<"google" | "calendly">().notNull(),
    externalId: text("external_id").notNull(),
    calendarId: text("calendar_id"),
    matchedBy: text("matched_by").$type<"attendee" | "title" | "calendar" | "calendly">().notNull(),
    title: text("title").notNull(),
    startsAt: tz("starts_at").notNull(),
    endsAt: tz("ends_at").notNull(),
    link: text("link"),
    location: text("location"),
    status: text("status").$type<MeetingStatus>().notNull().default("scheduled"),
    outcomeNote: text("outcome_note"),
    outcomeAt: tz("outcome_at"),
    outcomeBy: uuid("outcome_by"),
    /** When its owner was asked for the outcome (the "Log outcome" follow-up, once). */
    outcomeAskedAt: tz("outcome_asked_at"),
    outcomeTaskId: uuid("outcome_task_id"),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => [unique("meetings_once").on(t.source, t.ownerId, t.externalId)],
);
