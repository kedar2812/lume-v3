/** What a reply from LUME sends to Meta (plan W3a; spec 2026-10-18 §3.4), and Meta's refusals in words. */

export type OutboundFile = {
  kind: "image" | "video" | "audio" | "document";
  /** Meta's id for the uploaded file. */
  mediaId: string;
  caption?: string;
  /** A document's name, as the lead sees it. */
  filename?: string;
};

/** The body of Meta's `/{phone-number-id}/messages` call: one message to one person. */
export function outboundBody(to: string, m: { text: string } | OutboundFile): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to: to.replace(/\D/g, "") };
  if ("text" in m) return { ...base, type: "text", text: { body: m.text, preview_url: true } };
  const part: Record<string, string> = { id: m.mediaId };
  // Meta refuses a caption on audio; no caption is no field, never an empty one.
  if (m.caption && m.kind !== "audio") part.caption = m.caption;
  if (m.filename && m.kind === "document") part.filename = m.filename;
  return { ...base, type: m.kind, [m.kind]: part };
}

export type Refusal = { words: string; retry: boolean; token: boolean };
const TRY_AGAIN = "WhatsApp didn't take this message. Try again.";
const REFUSALS: Record<number, Refusal> = {
  131047: {
    words: "WhatsApp's 24 hours since the lead's last message had passed. Send it from the phone.",
    retry: false,
    token: false,
  },
  131026: { words: "This number can't get WhatsApp messages.", retry: false, token: false },
  131051: { words: "WhatsApp doesn't take this kind of message.", retry: false, token: false },
  131053: { words: "WhatsApp couldn't read this file.", retry: false, token: false },
  130472: { words: "WhatsApp held this message back.", retry: false, token: false },
  190: { words: "WhatsApp stopped letting LUME in. Connect this number again.", retry: false, token: true },
};
/** Meta busy, rate limits, its own hiccups: tried again with backoff. */
const PASSING = new Set([130429, 131056, 131000, 2, 4, 80007]);

/** Why Meta refused a send, in words; whether to try again; whether the number's token is the trouble. */
export function refusalOf(code: number | null): Refusal {
  if (code === null || PASSING.has(code)) return { words: TRY_AGAIN, retry: true, token: false };
  return REFUSALS[code] ?? { words: TRY_AGAIN, retry: false, token: false };
}

/** A message LUME sent only ever moves forward through these; `failed` is apart (see the sender). */
export const STATUS_RANK = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4 } as const;
export type OutboxStatus = keyof typeof STATUS_RANK | "failed";
