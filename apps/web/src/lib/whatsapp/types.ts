/** WhatsApp as the API says it (spec 2026-10-18 §3–4; plan W1 Tasks 4 and 7). */
export type WaNumber = {
  id: string;
  display: string;
  name: string | null;
  /** Whose number it is; null: the business's. */
  owner: { id: string; name: string } | null;
  status: "active" | "needs_attention" | "disconnected";
  problem: string | null;
  historyShared: boolean;
  connectedAt: string;
};
export type WaNumbers = { numbers: WaNumber[] };
export type WaPerson = {
  peer: string;
  name: string | null;
  number: { id: string; display: string };
  count: number;
  lastText: string | null;
  lastAt: string;
};
export type WaInboxMessage = { id: string; at: string; text: string | null; mediaId: string | null };
export type WaMediaInfo = {
  /** "removed": past the client's "keep files for"; "missing": the database has it, the disk doesn't. */
  status: "waiting" | "ready" | "too_large" | "failed" | "removed" | "missing";
  problem: string | null;
  kind: "image" | "audio" | "video" | "document" | "sticker";
  mime: string;
  filename: string | null;
  size: number | null;
  voice: boolean;
};
export type WaThreadMessage = {
  id: string;
  /** "in": from the lead; "out": sent from the business's phone. */
  direction: "in" | "out";
  at: string;
  text: string | null;
  media: {
    id: string;
    kind: WaMediaInfo["kind"];
    mime: string;
    filename: string | null;
    voice: boolean;
  } | null;
  /** Sent from LUME (plan W3a): who sent it, where it's got to, and why it failed. Null for the rest. */
  sentBy: { id: string; name: string } | null;
  status: WaSendStatus | null;
  problem: string | null;
  outboxId: string | null;
};
export type WaSendStatus = "queued" | "sending" | "sent" | "delivered" | "read" | "failed";
/** Whether this person may reply from LUME now, from which number, until when; null: no reply box at all. */
export type WaReply = {
  allowed: boolean;
  number: { id: string; display: string; ownerName: string | null } | null;
  until: string | null;
  reason: string | null;
} | null;
export type WaThread = { on: boolean; reply: WaReply; messages: WaThreadMessage[] };
/** A file attached in the reply box, not sent yet. */
export type WaAttached = {
  id: string;
  kind: "image" | "video" | "audio" | "document";
  mime: string;
  filename: string | null;
  size: number;
};
/** An approved template to send a lead (W3b-2), in their words, with what's missing and what it costs. */
export type WaTemplateOption = {
  submissionId: string;
  name: string;
  category: "MARKETING" | "UTILITY";
  preview: string;
  missing: string[];
  cost: { amount: number; currency: string; asOf: string } | null;
};
/** Null: nothing to offer here (replying from LUME off, or this person can't message the lead). */
export type WaTemplateState = {
  number: { id: string; display: string } | null;
  options: WaTemplateOption[];
  reason: string | null;
} | null;
/** "Keep WhatsApp files for" (2026-10-19): null keeps them forever. */
export type KeepMonths = 3 | 6 | 12 | 24 | null;
/** What a shorter "keep for" would remove: files, and about how many bytes it frees. */
export type KeepPreview = { files: number; bytes: number };
