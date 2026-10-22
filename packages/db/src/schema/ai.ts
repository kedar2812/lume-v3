import { integer, jsonb, pgTable, primaryKey, smallint, text, uuid } from "drizzle-orm/pg-core";
import type { AiTask } from "@lume/core/shared";
import { tz } from "./types";

/** LUME AI (spec 2026-10-18 §2.3): one row per read, seen with its lead. Only the outcome ever changes. */
export const aiReads = pgTable("ai_reads", {
  id: uuid("id").primaryKey(),
  leadId: uuid("lead_id").notNull(),
  userId: uuid("user_id").notNull(),
  task: text("task").$type<AiTask>().notNull(),
  sourceActivityId: uuid("source_activity_id"),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  status: text("status").$type<"pending" | "ok" | "failed">().notNull(),
  /** The cleaned output (a next step or a catch-up); null when the read failed. */
  result: jsonb("result").$type<Record<string, unknown> | null>(),
  outcome: text("outcome").$type<"applied" | "dismissed" | null>(),
  outcomeBy: uuid("outcome_by"),
  outcomeAt: tz("outcome_at"),
  createdAt: tz("created_at").notNull().defaultNow(),
});

/** Each limit notice to admins, once per window (§2.2). */
export const aiLimitNotices = pgTable(
  "ai_limit_notices",
  {
    kind: text("kind").$type<"week_75" | "week_90" | "week_limit" | "hour_limit">().notNull(),
    windowStart: tz("window_start").notNull(),
    sentAt: tz("sent_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.windowStart] })],
);

/** Settings → LUME AI (Autopilot spec 2026-10-19 §5): one document per business, read through mergeAiProfile. */
export const aiProfile = pgTable("ai_profile", {
  id: smallint("id").primaryKey(),
  profile: jsonb("profile").$type<Record<string, unknown>>().notNull(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  updatedBy: uuid("updated_by"),
});
