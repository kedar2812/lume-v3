import { sql } from "drizzle-orm";
import { char, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import type { RuleId } from "@lume/core";
import { bytea, tz } from "./types";

/** Phase 6A: one alert per person, rule and window (plan ruling R3), for everyone with `security.manage`. */
export const securityAlerts = pgTable("security_alerts", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  rule: text("rule").$type<RuleId>().notNull(),
  observed: integer("observed").notNull(),
  threshold: integer("threshold").notNull(),
  windowStart: tz("window_start").notNull(),
  windowEnd: tz("window_end").notNull(),
  action: text("action").$type<"alerted" | "suspended">().notNull(),
  status: text("status").$type<"open" | "resolved">().notNull().default("open"),
  resolution: text("resolution").$type<"restored" | "kept_suspended" | "offboarded" | "dismissed">(),
  resolvedBy: uuid("resolved_by"),
  resolvedAt: tz("resolved_at"),
  createdAt: tz("created_at").notNull().defaultNow(),
});

/** Phase 6B: a lead export, its code and check row (kept), and its sealed file (24 hours, plan ruling B2). */
export const leadExports = pgTable("lead_exports", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  code: char("code", { length: 9 }).notNull(),
  label: text("label").notNull(),
  format: text("format").$type<"csv" | "xlsx">().notNull(),
  filters: jsonb("filters")
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  columns: text("columns").array().notNull(),
  rowCount: integer("row_count").notNull(),
  checkName: text("check_name").notNull(),
  checkEmail: text("check_email").notNull(),
  checkPhone: text("check_phone").notNull(),
  // Null: the file had neither Email nor Phone, so it carries no check row (6B review).
  checkPosition: integer("check_position"),
  fileEnc: bytea("file_enc"),
  downloads: integer("downloads").notNull().default(0),
  lastDownloadedAt: tz("last_downloaded_at"),
  createdAt: tz("created_at").notNull().defaultNow(),
  expiresAt: tz("expires_at").notNull(),
  clearedAt: tz("cleared_at"),
});
