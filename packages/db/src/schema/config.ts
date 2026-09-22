import { sql } from "drizzle-orm";
import { boolean, integer, jsonb, numeric, pgTable, primaryKey, char, text, uuid } from "drizzle-orm/pg-core";
import { citext, tz } from "./types";

export type FieldOptionRow = { id: string; label: string; color?: string; archived?: boolean };

export const pipelines = pgTable("pipelines", {
  id: uuid("id").primaryKey(),
  name: citext("name").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  position: integer("position").notNull().default(0),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  archivedAt: tz("archived_at"),
});

export const stages = pgTable("stages", {
  id: uuid("id").primaryKey(),
  pipelineId: uuid("pipeline_id").notNull(),
  name: text("name").notNull(),
  color: text("color").notNull().default("neutral"),
  position: integer("position").notNull().default(0),
  kind: text("kind").$type<"open" | "won" | "lost">().notNull(),
  winProbability: numeric("win_probability", { precision: 5, scale: 2, mode: "number" }),
  slaHours: integer("sla_hours"),
  requiredFieldIds: uuid("required_field_ids")
    .array()
    .notNull()
    .default(sql`'{}'`),
  onEnter: jsonb("on_enter")
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  archivedAt: tz("archived_at"),
});

export const fieldDefinitions = pgTable("field_definitions", {
  id: uuid("id").primaryKey(),
  entity: text("entity").notNull().default("lead"),
  key: text("key").notNull().unique(),
  label: text("label").notNull(),
  type: text("type").$type<import("@lume/core").FieldType>().notNull(),
  options: jsonb("options")
    .$type<FieldOptionRow[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  isCore: boolean("is_core").notNull().default(false),
  isRequired: boolean("is_required").notNull().default(false),
  isUnique: boolean("is_unique").notNull().default(false),
  isSearchable: boolean("is_searchable").notNull().default(false),
  position: integer("position").notNull().default(0),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  archivedAt: tz("archived_at"),
});

export const lostReasons = pgTable("lost_reasons", {
  id: uuid("id").primaryKey(),
  label: citext("label").notNull(),
  position: integer("position").notNull().default(0),
  createdAt: tz("created_at").notNull().defaultNow(),
  archivedAt: tz("archived_at"),
});

export const tags = pgTable("tags", {
  id: uuid("id").primaryKey(),
  label: citext("label").notNull().unique(),
  color: text("color").notNull().default("neutral"),
  createdAt: tz("created_at").notNull().defaultNow(),
});

export const products = pgTable("products", {
  id: uuid("id").primaryKey(),
  name: citext("name").notNull(),
  defaultValue: numeric("default_value", { precision: 14, scale: 2, mode: "number" }),
  currency: char("currency", { length: 3 }),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  archivedAt: tz("archived_at"),
});

export const roleFieldAccess = pgTable(
  "role_field_access",
  {
    roleId: uuid("role_id").notNull(),
    fieldId: uuid("field_id").notNull(),
    access: text("access").$type<"hidden" | "view" | "edit">().notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.fieldId] })],
);
