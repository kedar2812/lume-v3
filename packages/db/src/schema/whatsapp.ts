import { bigserial, boolean, integer, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { bytea, tz } from "./types";

/** WhatsApp replies, part 1 (spec 2026-10-18 §3–4): a connected number. Its token never leaves the module. */
export const whatsappNumbers = pgTable("whatsapp_numbers", {
  id: uuid("id").primaryKey(),
  phoneNumberId: text("phone_number_id").notNull(),
  wabaId: text("waba_id").notNull(),
  displayPhone: text("display_phone").notNull(),
  verifiedName: text("verified_name"),
  /** Whose number it is; null: the business's. */
  ownerUserId: uuid("owner_user_id"),
  /** Who connected it: its jobs run as them. */
  runAs: uuid("run_as").notNull(),
  tokenEnc: bytea("token_enc"),
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

/** A photo, voice note, video or document, on this server; at most 25 MB. */
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
  data: bytea("data"),
  status: text("status").$type<"waiting" | "ready" | "too_large" | "failed">().notNull(),
  problem: text("problem"),
  tries: integer("tries").notNull().default(0),
  createdAt: tz("created_at").notNull().defaultNow(),
});
