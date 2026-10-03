import { sql } from "drizzle-orm";
import { boolean, integer, jsonb, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { tz } from "./types";

export type BulkRunStatus = "queued" | "running" | "done" | "cancelled" | "failed" | "undone";
export type BulkItemResult = "pending" | "done" | "skipped" | "failed";

/** Phase 7B: a bulk action, its selection in words and its counts (0049). */
export const bulkRuns = pgTable("bulk_runs", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  action: jsonb("action").$type<Record<string, unknown>>().notNull(),
  selection: jsonb("selection").$type<Record<string, unknown>>().notNull(),
  status: text("status").$type<BulkRunStatus>().notNull().default("queued"),
  total: integer("total").notNull(),
  done: integer("done").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  skippedBy: jsonb("skipped_by")
    .$type<Record<string, number>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  undoOf: uuid("undo_of"),
  error: text("error"),
  createdAt: tz("created_at").notNull().defaultNow(),
  startedAt: tz("started_at"),
  finishedAt: tz("finished_at"),
});

/** One lead in a run: its place, its result, and what undo would put back (0049). */
export const bulkRunItems = pgTable(
  "bulk_run_items",
  {
    runId: uuid("run_id").notNull(),
    leadId: uuid("lead_id").notNull(),
    position: integer("position").notNull(),
    result: text("result").$type<BulkItemResult>().notNull().default("pending"),
    code: text("code"),
    before: jsonb("before").$type<Record<string, unknown>>(),
    afterVersion: integer("after_version"),
  },
  (t) => [primaryKey({ columns: [t.runId, t.leadId] })],
);
