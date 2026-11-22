/** Every pg-boss queue LUME uses. The migrate step creates these as lume_owner (pg-boss partitions need the table owner). */
export const QUEUE_NAMES = [
  "ops.backup",
  "ops.restore-test",
  "ops.idempotency-cleanup",
  "imports.run",
  "imports.retention",
  "bulk.run",
  "sheets.sync",
  "sheets.retention",
  "calendar.sync",
  // Live sheets (2026-11-14): one run of a sheet LUME keeps in Google.
  "live-sheets.run",
  "webhooks.process",
  "webhooks.retention",
  "tasks.fire",
  "notifications.retention",
  "whatsapp.process",
  "whatsapp.media",
  "whatsapp.send",
  // W2: what a lead's WhatsApp reply means, read once by LUME AI.
  "whatsapp.meaning",
  "media.preview",
  // Autopilot (A2): a run with something to do now (written, revealed, sent; paced).
  "autopilot.step",
  // Instagram (NEW_FEATURES_PLAN §6): deliveries into conversations, replies out, files fetched, profiles read.
  "instagram.process",
  "instagram.send",
  "instagram.media",
  "instagram.profile",
  // Flows (plan 1B): a public reply under a comment, paced per account.
  "instagram.public",
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];
