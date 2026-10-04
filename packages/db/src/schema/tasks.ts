import { sql } from "drizzle-orm";
import {
  bigserial,
  date,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { Recurrence } from "@lume/core";
import { tz } from "./types";

export type TaskStatus = "open" | "done" | "cancelled";
export type NotificationKind = "follow_up_due" | "follow_up_soon" | "follow_up_assigned";

/** A follow-up on a lead, for one person, at a time (Phase 3 spec §4). Seen exactly when its lead is. */
export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey(),
  leadId: uuid("lead_id").notNull(),
  assigneeId: uuid("assignee_id").notNull(),
  type: text("type").$type<"follow_up" | "whatsapp">().notNull().default("follow_up"),
  templateId: uuid("template_id"),
  title: text("title").notNull(),
  note: text("note"),
  dueAt: tz("due_at").notNull(),
  status: text("status").$type<TaskStatus>().notNull().default("open"),
  remindMinutes: integer("remind_minutes")
    .array()
    .notNull()
    .default(sql`'{0}'`),
  recurrence: jsonb("recurrence").$type<Recurrence | null>(),
  seriesId: uuid("series_id").notNull(),
  autoRuleId: uuid("auto_rule_id"),
  createdBy: uuid("created_by"),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  doneAt: tz("done_at"),
  doneBy: uuid("done_by"),
  cancelledAt: tz("cancelled_at"),
  /** A meeting reminder's meeting (5C): it closes when that meeting is cancelled, moved or gone. */
  meetingId: uuid("meeting_id"),
  /** When its managers were told it was left overdue (3B); cleared when it's moved or snoozed. */
  escalatedAt: tz("escalated_at"),
  version: integer("version").notNull().default(1),
});

/** One per reminder of a follow-up; the fire job and the sweeper work through the pending ones. */
export const scheduledNotifications = pgTable(
  "scheduled_notifications",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    taskId: uuid("task_id").notNull(),
    offsetMinutes: integer("offset_minutes").notNull(),
    fireAt: tz("fire_at").notNull(),
    status: text("status").$type<"pending" | "fired" | "cancelled">().notNull().default("pending"),
    firedAt: tz("fired_at"),
  },
  (t) => [unique("sn_once").on(t.taskId, t.offsetMinutes)],
);

/** What LUME told a person; only ever theirs. Titles carry a lead's name, never a phone or email. */
export const notifications = pgTable("notifications", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: uuid("user_id").notNull(),
  kind: text("kind").$type<NotificationKind>().notNull(),
  taskId: uuid("task_id"),
  leadId: uuid("lead_id"),
  title: text("title").notNull(),
  body: text("body"),
  data: jsonb("data")
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: tz("created_at").notNull().defaultNow(),
  readAt: tz("read_at"),
  /** Hidden by "Clear read" (0062); the sweep removes it later, as any read notification. */
  clearedAt: tz("cleared_at"),
});

/** One digest a person a local day (3B): sent, and how many items it held. */
export const digestRuns = pgTable(
  "digest_runs",
  {
    userId: uuid("user_id").notNull(),
    localDate: date("local_date", { mode: "string" }).notNull(),
    sentAt: tz("sent_at").notNull().defaultNow(),
    items: integer("items").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.localDate] })],
);
