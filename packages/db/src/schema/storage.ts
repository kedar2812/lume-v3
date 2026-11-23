import { bigint, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { tz } from "./types";

/** Each clean-up (0126): what it set out to clear, how far it got, who started it. One runs at a time. */
export const storageCleanups = pgTable("storage_cleanups", {
  id: uuid("id").primaryKey(),
  kinds: text("kinds").array().notNull(),
  closedMonths: integer("closed_months"),
  status: text("status").$type<"running" | "done" | "failed">().notNull(),
  filesPlanned: integer("files_planned").notNull().default(0),
  bytesPlanned: bigint("bytes_planned", { mode: "number" }).notNull().default(0),
  filesDone: integer("files_done").notNull().default(0),
  bytesDone: bigint("bytes_done", { mode: "number" }).notNull().default(0),
  problem: text("problem"),
  startedBy: uuid("started_by"),
  startedAt: tz("started_at").notNull().defaultNow(),
  /** Last sign of work: a running clean-up quiet for long is queued again. */
  touchedAt: tz("touched_at").notNull().defaultNow(),
  finishedAt: tz("finished_at"),
});
