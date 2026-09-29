import { sql } from "drizzle-orm";
import { integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { citext, tz } from "./types";

/** A saved view (Phase 4B): the Leads list's filters under a name, a person's own or shared by role. */
export const savedViews = pgTable("saved_views", {
  id: uuid("id").primaryKey(),
  name: citext("name").notNull(),
  color: text("color").notNull().default("accent"),
  filters: jsonb("filters").$type<Record<string, unknown>>().notNull().default({}),
  ownerId: uuid("owner_id").notNull(),
  sharedRoleIds: uuid("shared_role_ids")
    .array()
    .notNull()
    .default(sql`'{}'`),
  position: integer("position").notNull().default(0),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  deletedAt: tz("deleted_at"),
});
