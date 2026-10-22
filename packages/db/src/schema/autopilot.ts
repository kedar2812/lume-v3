import type { Allow, AutopilotAction, LeadState, PauseReason, RunStatus } from "@lume/core/shared";
import { bigserial, boolean, integer, jsonb, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { tz } from "./types";

/** A run's goal (spec 2026-10-19 §1.1): one of the business's open stages, a reply, or the business's own brief. */
export type RunGoal =
  { kind: "stage"; stageId: string } | { kind: "reply" } | { kind: "brief"; text: string };

/** LUME AI working a selection of leads (Autopilot spec 2026-10-19 §1–§3): the business's choices at its start. */
export const autopilotRuns = pgTable("autopilot_runs", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  startedBy: uuid("started_by").notNull(),
  speakerId: uuid("speaker_id").notNull(),
  numberId: uuid("number_id").notNull(),
  goal: jsonb("goal").$type<RunGoal>().notNull(),
  permissions: jsonb("permissions").$type<Record<AutopilotAction, Allow>>().notNull(),
  followUpDays: integer("follow_up_days").array().notNull(),
  dailyCap: integer("daily_cap"),
  outsideHours: text("outside_hours").$type<"reply_any_time" | "wait">().notNull(),
  status: text("status").$type<RunStatus>().notNull().default("running"),
  pauseReason: text("pause_reason").$type<PauseReason>(),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  endedAt: tz("ended_at"),
});

/** Each lead in a run, with its own state (§2); `active` holds one run per lead (§3). */
export const autopilotLeads = pgTable(
  "autopilot_leads",
  {
    runId: uuid("run_id").notNull(),
    leadId: uuid("lead_id").notNull(),
    state: text("state").$type<LeadState>().notNull(),
    reason: text("reason"),
    card: jsonb("card").$type<{ headline: string; quote: string | null } | null>(),
    active: boolean("active").notNull().default(true),
    nextAt: tz("next_at"),
    firstSentAt: tz("first_sent_at"),
    lastSentAt: tz("last_sent_at"),
    lastInboundAt: tz("last_inbound_at"),
    followUpsSent: integer("follow_ups_sent").notNull().default(0),
    draft: text("draft"),
    draftPayload: jsonb("draft_payload").$type<Record<string, unknown> | null>(),
    fails: integer("fails").notNull().default(0),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.leadId] })],
);

/** "Ask me" (§1.3, §2.1): something LUME AI prepared, waiting for one tap. */
export const autopilotAsks = pgTable("autopilot_asks", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull(),
  leadId: uuid("lead_id").notNull(),
  action: text("action").$type<AutopilotAction>().notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  status: text("status").$type<"waiting" | "approved" | "declined" | "gone">().notNull().default("waiting"),
  createdAt: tz("created_at").notNull().defaultNow(),
  decidedBy: uuid("decided_by"),
  decidedAt: tz("decided_at"),
});

/** What happened in a run, for the live view and its history: ids and kinds only, never a lead's words. */
export const autopilotEvents = pgTable("autopilot_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  runId: uuid("run_id").notNull(),
  leadId: uuid("lead_id"),
  kind: text("kind").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  at: tz("at").notNull().defaultNow(),
});
