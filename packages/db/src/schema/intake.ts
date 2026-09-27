import { sql } from "drizzle-orm";
import { bigserial, integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { bytea, tz } from "./types";

export const leadSources = pgTable("lead_sources", {
  id: uuid("id").primaryKey(),
  type: text("type").$type<"csv" | "google_sheet" | "webhook" | "manual">().notNull(),
  name: text("name").notNull(),
  configEnc: bytea("config_enc"),
  mapping: jsonb("mapping")
    .notNull()
    .default(sql`'{}'::jsonb`),
  rules: jsonb("rules")
    .notNull()
    .default(sql`'{}'::jsonb`),
  status: text("status")
    .$type<"active" | "paused" | "needs_attention" | "archived">()
    .notNull()
    .default("active"),
  lastSyncedAt: tz("last_synced_at"),
  lastError: text("last_error"),
  createdBy: uuid("created_by"),
  createdAt: tz("created_at").notNull().defaultNow(),
  archivedAt: tz("archived_at"),
});

export type ImportStatus =
  "draft" | "queued" | "running" | "cancelling" | "cancelled" | "stopped_access" | "failed" | "done";

export const imports = pgTable("imports", {
  id: uuid("id").primaryKey(),
  sourceId: uuid("source_id").notNull(),
  kind: text("kind").$type<"csv">().notNull(),
  status: text("status").$type<ImportStatus>().notNull(),
  fileEnc: bytea("file_enc"),
  fileSha256: text("file_sha256").notNull(),
  fileName: text("file_name").notNull(),
  fileBytes: integer("file_bytes").notNull(),
  encoding: text("encoding"),
  delimiter: text("delimiter"),
  headerRow: integer("header_row"),
  headers: jsonb("headers")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  rowCount: integer("row_count").notNull().default(0),
  mapping: jsonb("mapping")
    .notNull()
    .default(sql`'{}'::jsonb`),
  rules: jsonb("rules")
    .notNull()
    .default(sql`'{}'::jsonb`),
  columnSettings: jsonb("column_settings")
    .notNull()
    .default(sql`'{}'::jsonb`),
  cursorRow: integer("cursor_row").notNull().default(0),
  rrCursor: integer("rr_cursor").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  created: integer("created").notNull().default(0),
  merged: integer("merged").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  empty: integer("empty").notNull().default(0),
  errors: integer("errors").notNull().default(0),
  warnings: integer("warnings").notNull().default(0),
  nameFromContact: integer("name_from_contact").notNull().default(0),
  missingStageFields: integer("missing_stage_fields").notNull().default(0),
  phoneNeedsCountry: integer("phone_needs_country").notNull().default(0),
  startedBy: uuid("started_by"),
  createdBy: uuid("created_by"),
  createdAt: tz("created_at").notNull().defaultNow(),
  startedAt: tz("started_at"),
  finishedAt: tz("finished_at"),
  seenAt: tz("seen_at"),
  stopReason: text("stop_reason"),
  purgedAt: tz("purged_at"),
});

export const importRows = pgTable(
  "import_rows",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    importId: uuid("import_id").notNull(),
    rowIndex: integer("row_index").notNull(),
    fingerprint: text("fingerprint"),
    rawEnc: bytea("raw_enc"),
    result: text("result").$type<"pending" | "created" | "merged" | "skipped" | "error">().notNull(),
    leadId: uuid("lead_id"),
    problems: jsonb("problems")
      .$type<{ column: number | null; code: string; message: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    warnings: jsonb("warnings")
      .$type<{ column: number | null; code: string; message: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    alsoMatched: uuid("also_matched")
      .array()
      .notNull()
      .default(sql`'{}'`),
  },
  (t) => [unique("import_rows_once").on(t.importId, t.rowIndex)],
);

export const importMappingMemory = pgTable("import_mapping_memory", {
  headerSignature: text("header_signature").primaryKey(),
  mapping: jsonb("mapping").notNull(),
  rules: jsonb("rules").notNull(),
  updatedBy: uuid("updated_by"),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});
