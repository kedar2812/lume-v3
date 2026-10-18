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
  status: "waiting" | "ready" | "too_large" | "failed";
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
};
export type WaThread = { on: boolean; messages: WaThreadMessage[] };
