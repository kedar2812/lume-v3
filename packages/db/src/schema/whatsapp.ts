import {
  bigint,
  bigserial,
  boolean,
  char,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea, tz } from "./types";

/** WhatsApp replies, part 1 (spec 2026-10-18 §3–4): a connected number. Its token never leaves the module. */
export const whatsappNumbers = pgTable("whatsapp_numbers", {
  id: uuid("id").primaryKey(),
  phoneNumberId: text("phone_number_id").notNull(),
  wabaId: text("waba_id").notNull(),
  displayPhone: text("display_phone").notNull(),
  /** Meta's quality rating (Autopilot A2): null until read. A drop to yellow or red pauses LUME AI's runs on it. */
  quality: text("quality").$type<"green" | "yellow" | "red">(),
  /** Meta's messaging tier ("TIER_1K"): how many people a day; null until read. */
  messagingTier: text("messaging_tier"),
  healthAt: tz("health_at"),
  verifiedName: text("verified_name"),
  /** Whose number it is; null: the business's. */
  ownerUserId: uuid("owner_user_id"),
  /** Who connected it: its jobs run as them. */
  runAs: uuid("run_as").notNull(),
  tokenEnc: bytea("token_enc"),
  /** When the token was given or last refreshed (Meta's last 60 days); null: since connectedAt. */
  tokenAt: tz("token_at"),
  status: text("status").$type<"active" | "needs_attention" | "disconnected">().notNull(),
  problem: text("problem"),
  historyShared: boolean("history_shared").notNull().default(false),
  connectedAt: tz("connected_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

/** Each delivered message, once; its event encrypted while it waits, cleared when processed. */
export const whatsappEvents = pgTable("whatsapp_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  phoneNumberId: text("phone_number_id").notNull(),
  wamid: text("wamid").notNull(),
  kind: text("kind").$type<"received" | "sent" | "history_received" | "history_sent">().notNull(),
  eventEnc: bytea("event_enc"),
  status: text("status").$type<"queued" | "done" | "error">().notNull(),
  problem: text("problem"),
  receivedAt: tz("received_at").notNull().defaultNow(),
  processedAt: tz("processed_at"),
});

/** "Not a lead yet": a stranger's message, kept 14 days. */
export const whatsappInbox = pgTable("whatsapp_inbox", {
  id: uuid("id").primaryKey(),
  numberId: uuid("number_id").notNull(),
  peer: text("peer").notNull(),
  name: text("name"),
  wamid: text("wamid").notNull(),
  at: tz("at").notNull(),
  text: text("text"),
  mediaId: uuid("media_id"),
  createdAt: tz("created_at").notNull().defaultNow(),
});

/** "Not a lead": never shown again on that number. */
export const whatsappIgnored = pgTable(
  "whatsapp_ignored",
  {
    numberId: uuid("number_id").notNull(),
    peer: text("peer").notNull(),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.numberId, t.peer] })],
);

/** A file on this server's disk, named by its SHA-256 (migration 0074): one file however many media point at it. */
export const whatsappFiles = pgTable("whatsapp_files", {
  sha256: text("sha256").primaryKey(),
  size: bigint("size", { mode: "number" }).notNull(),
  /** Kept by a trigger on whatsapp_media; the hourly sweep removes a file at 0. */
  refs: integer("refs").notNull().default(0),
  lastRefAt: tz("last_ref_at").notNull().defaultNow(),
  createdAt: tz("created_at").notNull().defaultNow(),
});

/**
 * The business's file library (W3b-1, migration 0077): a brochure, price list or photo kept once in the shared store
 * and sent from any lead; its share link sealed (to show again) and hashed (to find it).
 */
export const messageFiles = pgTable("message_files", {
  id: uuid("id").primaryKey(),
  sha256: text("sha256").notNull(),
  name: text("name").notNull(),
  mime: text("mime").notNull(),
  kind: text("kind").$type<"image" | "video" | "audio" | "document">().notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  linkHash: text("link_hash"),
  linkEnc: bytea("link_enc"),
  linkOn: boolean("link_on").notNull().default(false),
  opens: integer("opens").notNull().default(0),
  createdBy: uuid("created_by"),
  createdAt: tz("created_at").notNull().defaultNow(),
  archivedAt: tz("archived_at"),
});

/**
 * What LUME shows of a file before it's opened (Media, migration 0080): a thumbnail of its content, an Office file's
 * PDF, and what's known of it. Keyed by the bytes, so the same file under two names is rendered once.
 */
export const filePreviews = pgTable("file_previews", {
  sha256: text("sha256").primaryKey(),
  state: text("state").$type<"pending" | "ready" | "none" | "failed">().notNull().default("pending"),
  thumbSha256: text("thumb_sha256"),
  pdfSha256: text("pdf_sha256"),
  pages: integer("pages"),
  durationMs: integer("duration_ms"),
  width: integer("width"),
  height: integer("height"),
  tries: integer("tries").notNull().default(0),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

/** Files gone from the server: their off-site copies go 200 days later. */
export const whatsappFilesGone = pgTable("whatsapp_files_gone", {
  sha256: text("sha256").primaryKey(),
  goneAt: tz("gone_at").notNull().defaultNow(),
});

/** A photo, voice note, video or document, kept on this server's disk; at most 25 MB. */
export const whatsappMedia = pgTable("whatsapp_media", {
  id: uuid("id").primaryKey(),
  numberId: uuid("number_id").notNull(),
  metaId: text("meta_id").notNull(),
  leadId: uuid("lead_id"),
  inboxId: uuid("inbox_id"),
  kind: text("kind").$type<"image" | "audio" | "video" | "document" | "sticker">().notNull(),
  mime: text("mime").notNull(),
  filename: text("filename"),
  voice: boolean("voice").notNull().default(false),
  size: integer("size"),
  /** The file on disk (whatsapp_files) once it's here: status 'ready'. */
  sha256: text("sha256"),
  status: text("status").$type<"waiting" | "ready" | "too_large" | "failed" | "removed">().notNull(),
  problem: text("problem"),
  tries: integer("tries").notNull().default(0),
  /** Not tried again before this (the disk was full, or the folder not writable). */
  retryAt: tz("retry_at"),
  /** Attached in the composer and not sent yet (W3a); removed after a day if it never goes. */
  draft: boolean("draft").notNull().default(false),
  uploadedBy: uuid("uploaded_by"),
  createdAt: tz("created_at").notNull().defaultNow(),
});

/** A reply sent from LUME (plan W3a), from Send until read, or why it failed. Seen exactly as its lead is. */
export const whatsappOutbox = pgTable("whatsapp_outbox", {
  id: uuid("id").primaryKey(),
  leadId: uuid("lead_id").notNull(),
  numberId: uuid("number_id").notNull(),
  userId: uuid("user_id").notNull(),
  activityId: uuid("activity_id"),
  clientKey: uuid("client_key").notNull(),
  text: text("text"),
  mediaId: uuid("media_id"),
  taskId: uuid("task_id"),
  status: text("status")
    .$type<"queued" | "sending" | "sent" | "delivered" | "read" | "failed" | "cancelled">()
    .notNull(),
  /** LUME AI's (Autopilot A2): its run; cancelled, never sent, when the run paused or ended before it went. */
  autopilotRunId: uuid("autopilot_run_id"),
  wamid: text("wamid"),
  problem: text("problem"),
  tries: integer("tries").notNull().default(0),
  /** An approved template (W3b-2) with this lead's values for its numbered variables, in order. */
  submissionId: uuid("submission_id"),
  params: jsonb("params").$type<string[]>(),
  /** What WhatsApp charges for it, "about", as shown when it was sent; and whether it counts against the limit. */
  cost: numeric("cost", { precision: 10, scale: 4 }),
  costCurrency: char("cost_currency", { length: 3 }),
  paid: boolean("paid").notNull().default(false),
  /** The one message a stop allows (LUME AI's apology, Autopilot A2): it goes after do not contact. */
  allowAfterDnc: boolean("allow_after_dnc").notNull().default(false),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

/**
 * A template version sent to WhatsApp for approval (W3b-2), per business account and language. `tokens` are LUME's
 * variables in the order of WhatsApp's numbers.
 */
export const whatsappTemplateSubmissions = pgTable("whatsapp_template_submissions", {
  id: uuid("id").primaryKey(),
  templateVersionId: uuid("template_version_id").notNull(),
  wabaId: text("waba_id").notNull(),
  language: text("language").notNull(),
  category: text("category").$type<"MARKETING" | "UTILITY">().notNull(),
  metaName: text("meta_name").notNull(),
  metaTemplateId: text("meta_template_id"),
  headerFileId: uuid("header_file_id"),
  tokens: jsonb("tokens").$type<string[]>().notNull().default([]),
  status: text("status")
    .$type<"submitting" | "pending" | "approved" | "rejected" | "paused" | "disabled" | "failed">()
    .notNull(),
  reason: text("reason"),
  submittedBy: uuid("submitted_by"),
  submittedAt: tz("submitted_at").notNull().defaultNow(),
  decidedAt: tz("decided_at"),
});

/** A file uploaded to Meta for a number: its Meta id, reused for 25 days (Meta's last 30). */
export const whatsappMetaUploads = pgTable(
  "whatsapp_meta_uploads",
  {
    numberId: uuid("number_id").notNull(),
    sha256: text("sha256").notNull(),
    metaMediaId: text("meta_media_id").notNull(),
    uploadedAt: tz("uploaded_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.numberId, t.sha256] })],
);
