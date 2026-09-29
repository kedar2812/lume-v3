import { pgTable, smallint, text } from "drizzle-orm/pg-core";
import { tz } from "./types";

/** What this instance knows of its licence (licensing L-A): one row, the last good token and its timings. */
export const licenceState = pgTable("licence_state", {
  id: smallint("id").primaryKey().default(1),
  token: text("token"),
  firstBootAt: tz("first_boot_at").notNull().defaultNow(),
  lastAttemptAt: tz("last_attempt_at"),
  lastSuccessAt: tz("last_success_at"),
  lastError: text("last_error"),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});
