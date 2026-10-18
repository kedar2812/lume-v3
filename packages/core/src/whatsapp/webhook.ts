import { z } from "zod";

/**
 * Meta's WhatsApp deliveries as LUME reads them (spec 2026-10-18 §4.1): a lead's message to the business, one sent
 * from the business's phone (coexistence echoes), and past chats shared at connect. Pure; never throws.
 */
export type WaMedia = {
  id: string;
  kind: "image" | "audio" | "video" | "document" | "sticker";
  mime: string;
  filename: string | null;
  caption: string | null;
  voice: boolean;
};
export type WaEvent = {
  kind: "received" | "sent" | "history_received" | "history_sent";
  phoneNumberId: string;
  /** The lead's side of the chat, E.164 with "+". */
  peer: string;
  wamid: string;
  at: string;
  text: string | null;
  media: WaMedia | null;
  /** The name on the lead's WhatsApp profile, when Meta sends it. */
  name: string | null;
};

const MEDIA = ["image", "audio", "video", "document", "sticker"] as const;
/** What LUME can't show, in words: the person still learns something arrived. */
const IN_WORDS: Record<string, string> = {
  location: "Sent a location",
  contacts: "Shared a contact",
  interactive: "Tapped a reply button",
  button: "Tapped a button",
  order: "Sent an order",
};
const UNKNOWN = "Sent a message LUME can't show. Open it on the phone.";

const mediaPart = z.object({
  id: z.string(),
  mime_type: z.string().default("application/octet-stream"),
  filename: z.string().optional(),
  caption: z.string().optional(),
  voice: z.boolean().optional(),
});
const message = z
  .object({
    from: z.string().optional(),
    to: z.string().optional(),
    id: z.string(),
    timestamp: z.string().regex(/^\d+$/),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
    reaction: z.object({ emoji: z.string().optional() }).optional(),
  })
  .catchall(z.unknown());
type Message = z.infer<typeof message>;
const metadata = z.object({ display_phone_number: z.string(), phone_number_id: z.string() });
const change = z.object({ field: z.string(), value: z.object({ metadata }).catchall(z.unknown()) });
const body = z.object({ entry: z.array(z.object({ changes: z.array(z.unknown()) })) });

const e164 = (waId: string) => `+${waId.replace(/\D/g, "")}`;
const iso = (seconds: string) => new Date(Number(seconds) * 1000).toISOString();

function contentOf(m: Message): Pick<WaEvent, "text" | "media"> {
  if (m.type === "text") return { text: m.text?.body ?? null, media: null };
  if ((MEDIA as readonly string[]).includes(m.type)) {
    const p = mediaPart.safeParse(m[m.type]);
    if (!p.success) return { text: UNKNOWN, media: null };
    return {
      text: p.data.caption ?? null,
      media: {
        id: p.data.id,
        kind: m.type as WaMedia["kind"],
        mime: p.data.mime_type,
        filename: p.data.filename ?? null,
        caption: p.data.caption ?? null,
        voice: p.data.voice ?? false,
      },
    };
  }
  if (m.type === "reaction") return { text: `Reacted ${m.reaction?.emoji ?? ""}`.trim(), media: null };
  return { text: IN_WORDS[m.type] ?? UNKNOWN, media: null };
}

/** Each message of each change it understands; anything malformed is left out, never thrown. */
export function readWebhook(raw: unknown): WaEvent[] {
  const b = body.safeParse(raw);
  if (!b.success) return [];
  const out: WaEvent[] = [];
  for (const entry of b.data.entry)
    for (const c of entry.changes) {
      const ch = change.safeParse(c);
      if (!ch.success) continue;
      const v = ch.data.value;
      const phoneNumberId = v.metadata.phone_number_id;
      const business = v.metadata.display_phone_number.replace(/\D/g, "");
      const push = (kind: WaEvent["kind"], m: unknown, peer: string | undefined, name: string | null) => {
        const p = message.safeParse(m);
        if (!p.success || !peer) return;
        out.push({
          kind,
          phoneNumberId,
          peer: e164(peer),
          wamid: p.data.id,
          at: iso(p.data.timestamp),
          ...contentOf(p.data),
          name,
        });
      };
      if (ch.data.field === "messages" && Array.isArray(v.messages)) {
        const names = new Map<string, string>();
        for (const k of Array.isArray(v.contacts) ? v.contacts : []) {
          const x = z.object({ wa_id: z.string(), profile: z.object({ name: z.string() }) }).safeParse(k);
          if (x.success) names.set(x.data.wa_id, x.data.profile.name);
        }
        for (const m of v.messages) {
          const from = message.safeParse(m).data?.from;
          push("received", m, from, from ? (names.get(from) ?? null) : null);
        }
      } else if (ch.data.field === "smb_message_echoes" && Array.isArray(v.message_echoes)) {
        for (const m of v.message_echoes) push("sent", m, message.safeParse(m).data?.to, null);
      } else if (ch.data.field === "history" && Array.isArray(v.history)) {
        for (const h of v.history) {
          const threads = z
            .object({ threads: z.array(z.object({ id: z.string(), messages: z.array(z.unknown()) })) })
            .safeParse(h);
          if (!threads.success) continue;
          for (const t of threads.data.threads)
            for (const m of t.messages) {
              const from = message.safeParse(m).data?.from?.replace(/\D/g, "");
              push(from === business ? "history_sent" : "history_received", m, t.id, null);
            }
        }
      }
    }
  return out;
}
