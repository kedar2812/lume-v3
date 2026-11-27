import { boolean, integer, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { tz } from "./types";

export type QueueStatus = "active" | "paused" | "finished" | "cancelled";
export type QueueItemStatus = "pending" | "sending" | "sent" | "not_sent" | "skipped";

/** A person's run through a list of leads, one message each (Phase 4C). */
export const sendQueues = pgTable("send_queues", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  templateVersionId: uuid("template_version_id"),
  source: text("source").notNull(),
  sourceName: text("source_name").notNull(),
  status: text("status").$type<QueueStatus>().notNull().default("active"),
  pausedReason: text("paused_reason"),
  /** The WhatsApp number it sends from, chosen at its start (2026-11-26); null: a run from before. */
  numberId: uuid("number_id"),
  /** It asked which number (every run since 2026-11-26): without one, its leads open WhatsApp. */
  numberAsked: boolean("number_asked").notNull().default(false),
  createdAt: tz("created_at").notNull().defaultNow(),
  finishedAt: tz("finished_at"),
});

/** One lead in a run, in its place. */
export const sendQueueItems = pgTable(
  "send_queue_items",
  {
    queueId: uuid("queue_id").notNull(),
    position: integer("position").notNull(),
    leadId: uuid("lead_id").notNull(),
    status: text("status").$type<QueueItemStatus>().notNull().default("pending"),
    reason: text("reason"),
    textOverride: text("text_override"),
    /** Sent from LUME (the focus run inside LUME): the message it went as; refused later, the item is Not sent. */
    outboxId: uuid("outbox_id"),
    doneAt: tz("done_at"),
  },
  (t) => [primaryKey({ columns: [t.queueId, t.position] })],
);
