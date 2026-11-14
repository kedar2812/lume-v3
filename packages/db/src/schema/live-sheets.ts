import { sql } from "drizzle-orm";
import { boolean, integer, jsonb, pgTable, primaryKey, text, unique, uuid } from "drizzle-orm/pg-core";
import { bytea, tz } from "./types";

/** Live sheets (0109, spec 2026-11-14). */
export type LiveSheetStatus = "making" | "live" | "updating" | "paused";
export type LiveSheetPause =
  "google_disconnected" | "sheet_gone" | "maker_gone" | "tier" | "licence" | "paused_by_person";
export type LiveSheetRunTrigger = "make" | "schedule" | "refresh" | "now" | "edit";
export type LiveSheetRunStatus = "queued" | "running" | "done" | "failed";

/** A person's Google account for live sheets. Their own row; a run reads it with the sweep flag. */
export const liveSheetGrants = pgTable(
  "live_sheet_grants",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull(),
    googleEmail: text("google_email").notNull(),
    /** Sealed with the instance keyring, bound to `live-sheet-grant:<id>`. */
    grantEnc: bytea("grant_enc").notNull(),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("live_sheet_grants_one").on(t.userId, t.googleEmail)],
);

export const liveSheets = pgTable("live_sheets", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  preset: text("preset").$type<"meta" | "own">().notNull(),
  /** A LiveSheetRule (@lume/core). */
  rule: jsonb("rule").$type<Record<string, unknown>>().notNull(),
  columns: jsonb("columns")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  header: jsonb("header")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  edits: text("edits").$type<"keep" | "replace">().notNull(),
  grantId: uuid("grant_id"),
  spreadsheetId: text("spreadsheet_id"),
  writtenName: text("written_name"),
  url: text("url"),
  tabId: integer("tab_id"),
  madeBy: uuid("made_by").notNull(),
  runsAs: uuid("runs_as").notNull(),
  status: text("status").$type<LiveSheetStatus>().notNull().default("making"),
  pauseReason: text("pause_reason").$type<LiveSheetPause>(),
  lastError: text("last_error"),
  leadCount: integer("lead_count").notNull().default(0),
  capped: boolean("capped").notNull().default(false),
  googleModifiedAt: text("google_modified_at"),
  lastSyncedAt: tz("last_synced_at"),
  nextSyncAt: tz("next_sync_at").notNull().defaultNow(),
  failures: integer("failures").notNull().default(0),
  pollSeconds: integer("poll_seconds").notNull().default(120),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  deletedAt: tz("deleted_at"),
});

/** What LUME last wrote for a lead's row. No foreign key to the lead (a purged lead's row still has to leave). */
export const liveSheetRows = pgTable(
  "live_sheet_rows",
  {
    sheetId: uuid("sheet_id").notNull(),
    leadId: uuid("lead_id").notNull(),
    hash: text("hash").notNull(),
    cells: jsonb("cells").$type<(string | number | null)[]>().notNull(),
    editedCols: integer("edited_cols")
      .array()
      .notNull()
      .default(sql`'{}'`),
    removedByHand: boolean("removed_by_hand").notNull().default(false),
    writtenAt: tz("written_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sheetId, t.leadId] })],
);

export const liveSheetRuns = pgTable("live_sheet_runs", {
  id: uuid("id").primaryKey(),
  sheetId: uuid("sheet_id").notNull(),
  trigger: text("trigger").$type<LiveSheetRunTrigger>().notNull(),
  requestedBy: uuid("requested_by"),
  status: text("status").$type<LiveSheetRunStatus>().notNull(),
  total: integer("total").notNull().default(0),
  written: integer("written").notNull().default(0),
  error: text("error"),
  requestedAt: tz("requested_at").notNull().defaultNow(),
  startedAt: tz("started_at"),
  finishedAt: tz("finished_at"),
});
