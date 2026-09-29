import { sql } from "drizzle-orm";
import { integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import type { TemplateCategory } from "@lume/core";
import { citext, tz } from "./types";

/** A WhatsApp template (Phase 4A): configuration, like stages; its words live in its versions. */
export const messageTemplates = pgTable("message_templates", {
  id: uuid("id").primaryKey(),
  name: citext("name").notNull(),
  category: text("category").$type<TemplateCategory>().notNull(),
  allowedRoleIds: uuid("allowed_role_ids")
    .array()
    .notNull()
    .default(sql`'{}'`),
  currentVersionId: uuid("current_version_id"),
  position: integer("position").notNull().default(0),
  createdBy: uuid("created_by"),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  archivedAt: tz("archived_at"),
});

/** One edit of a template, never changed: a send points at the version it used. */
export const templateVersions = pgTable("template_versions", {
  id: uuid("id").primaryKey(),
  templateId: uuid("template_id").notNull(),
  body: text("body").notNull(),
  createdBy: uuid("created_by"),
  createdAt: tz("created_at").notNull().defaultNow(),
});
