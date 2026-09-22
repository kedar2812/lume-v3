import { sql } from "drizzle-orm";
import {
  bigserial,
  char,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { citext, tz } from "./types";

export const leads = pgTable("leads", {
  id: uuid("id").primaryKey(),
  pipelineId: uuid("pipeline_id").notNull(),
  stageId: uuid("stage_id").notNull(),
  ownerId: uuid("owner_id"),
  name: text("name").notNull(),
  phoneRaw: text("phone_raw"),
  phoneE164: text("phone_e164"),
  phoneCountryIso: char("phone_country_iso", { length: 2 }),
  phoneStatus: text("phone_status")
    .$type<"valid" | "needs_country" | "invalid" | "missing">()
    .notNull()
    .default("missing"),
  phoneDigits: text("phone_digits").generatedAlwaysAs(
    sql`regexp_replace(coalesce(phone_e164, phone_raw, ''), '\\D', '', 'g')`,
  ),
  email: citext("email"),
  instagramHandle: citext("instagram_handle"),
  sourceId: uuid("source_id"),
  externalRef: text("external_ref"),
  value: numeric("value", { precision: 14, scale: 2, mode: "number" }),
  currency: char("currency", { length: 3 }),
  productId: uuid("product_id"),
  lostReasonId: uuid("lost_reason_id"),
  lostNote: text("lost_note"),
  wonAt: tz("won_at"),
  lostAt: tz("lost_at"),
  custom: jsonb("custom")
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  leadCreatedAt: date("lead_created_at", { mode: "string" }),
  lastActivityAt: tz("last_activity_at"),
  nextTaskDueAt: tz("next_task_due_at"),
  stageEnteredAt: tz("stage_entered_at").notNull().defaultNow(),
  version: integer("version").notNull().default(1),
  createdBy: uuid("created_by"),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  deletedAt: tz("deleted_at"),
});

export const leadTags = pgTable(
  "lead_tags",
  { leadId: uuid("lead_id").notNull(), tagId: uuid("tag_id").notNull() },
  (t) => [primaryKey({ columns: [t.leadId, t.tagId] })],
);

export const leadStageHistory = pgTable("lead_stage_history", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  leadId: uuid("lead_id").notNull(),
  fromStageId: uuid("from_stage_id"),
  toStageId: uuid("to_stage_id").notNull(),
  pipelineId: uuid("pipeline_id").notNull(),
  changedBy: uuid("changed_by"),
  changedAt: tz("changed_at").notNull().defaultNow(),
});

export const leadAssignmentHistory = pgTable("lead_assignment_history", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  leadId: uuid("lead_id").notNull(),
  fromUserId: uuid("from_user_id"),
  toUserId: uuid("to_user_id"),
  changedBy: uuid("changed_by"),
  changedAt: tz("changed_at").notNull().defaultNow(),
  reason: text("reason"),
});

export const activities = pgTable("activities", {
  id: uuid("id").primaryKey(),
  leadId: uuid("lead_id").notNull(),
  userId: uuid("user_id"),
  type: text("type").notNull(),
  payload: jsonb("payload")
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  occurredAt: tz("occurred_at").notNull().defaultNow(),
});

export const leadContactKeys = pgTable(
  "lead_contact_keys",
  {
    leadId: uuid("lead_id").notNull(),
    kind: text("kind").$type<"phone" | "email" | "instagram">().notNull(),
    keyHash: text("key_hash").notNull(),
  },
  (t) => [primaryKey({ columns: [t.leadId, t.kind] })],
);

export const revealCounters = pgTable(
  "reveal_counters",
  {
    userId: uuid("user_id").notNull(),
    hour: tz("hour").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.hour] })],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    userId: uuid("user_id").notNull(),
    key: text("key").notNull(),
    route: text("route").notNull(),
    requestHash: text("request_hash").notNull(),
    status: integer("status").notNull(),
    response: jsonb("response"),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);
