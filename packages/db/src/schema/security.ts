import { integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import type { RuleId } from "@lume/core";
import { tz } from "./types";

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
