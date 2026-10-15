import { pgTable, smallint, text, uuid } from "drizzle-orm/pg-core";
import { bytea, tz } from "./types";

/** What this instance knows of its licence (licensing L-A): one row, the last good token and its timings. */
export const licenceState = pgTable("licence_state", {
  id: smallint("id").primaryKey().default(1),
  token: text("token"),
  firstBootAt: tz("first_boot_at").notNull().defaultNow(),
  lastAttemptAt: tz("last_attempt_at"),
  lastSuccessAt: tz("last_success_at"),
  lastError: text("last_error"),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  /** This install's own random id (spec 2026-10-15 §1.2): its key answers this server only. */
  installId: uuid("install_id").notNull().defaultRandom(),
  /** The product key the owner gave, sealed with the keyring (context "licence-key"). */
  licenseKeyEnc: bytea("license_key_enc"),
  instanceId: text("instance_id"),
  activatedAt: tz("activated_at"),
});
