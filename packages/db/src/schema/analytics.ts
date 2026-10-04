import { date, numeric, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { tz } from "./types";

/** A goal (8A, 0052): a target for one person, one team or the whole business, for a month or a quarter. */
export const goals = pgTable("goals", {
  id: uuid("id").primaryKey(),
  scope: text("scope").$type<"user" | "team" | "business">().notNull(),
  scopeId: uuid("scope_id"),
  metric: text("metric").$type<"won" | "revenue" | "calls_held" | "new_leads" | "ontime">().notNull(),
  period: text("period").$type<"month" | "quarter">().notNull(),
  periodStart: date("period_start").notNull(),
  target: numeric("target", { precision: 14, scale: 2 }).notNull(),
  createdBy: uuid("created_by"),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

/** Suggestions each person has been shown, and how big they were (cooldown, spec §6.4). */
export const analyticsInsightSeen = pgTable(
  "analytics_insight_seen",
  {
    userId: uuid("user_id").notNull(),
    detector: text("detector").notNull(),
    subject: text("subject").notNull(),
    magnitude: numeric("magnitude").notNull(),
    shownAt: tz("shown_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.detector, t.subject] })],
);
