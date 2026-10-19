/**
 * Meta's WhatsApp webhook bodies as its docs show them (Cloud API `messages`, coexistence `smb_message_echoes` and
 * `history`). Used by tests here, by the API's tests and by the fake Meta. To verify against the test number.
 */
export const PHONE_NUMBER_ID = "106540352242922";
export const WABA_ID = "102290129340398";
const metadata = { display_phone_number: "919000000001", phone_number_id: PHONE_NUMBER_ID };
const ts = (iso: string) => String(Math.floor(Date.parse(iso) / 1000));

export const envelope = (field: string, value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [
    { id: WABA_ID, changes: [{ field, value: { messaging_product: "whatsapp", metadata, ...value } }] },
  ],
});

/** A message a lead sent to the business. */
export function inbound(
  o: { from?: string; name?: string; id?: string; at?: string } & Record<string, unknown> = {},
) {
  const {
    from = "919876543210",
    name = "Sneha Reddy",
    id = "wamid.IN1",
    at = "2026-10-21T06:00:00Z",
    ...m
  } = o;
  return envelope("messages", {
    contacts: [{ profile: { name }, wa_id: from }],
    messages: [
      {
        from,
        id,
        timestamp: ts(at),
        ...(Object.keys(m).length ? m : { type: "text", text: { body: "Yes, Saturday works" } }),
      },
    ],
  });
}

/** A message the business sent from the WhatsApp Business app on its phone. */
export function echo(o: { to?: string; id?: string; at?: string; text?: string } = {}) {
  const {
    to = "919876543210",
    id = "wamid.OUT1",
    at = "2026-10-21T06:05:00Z",
    text = "See you Saturday",
  } = o;
  return envelope("smb_message_echoes", {
    message_echoes: [
      { from: metadata.display_phone_number, to, id, timestamp: ts(at), type: "text", text: { body: text } },
    ],
  });
}

/** One chunk of past chats, shared at connect. */
export function history(
  threads: { id: string; messages: { from: string; id: string; at: string; text: string }[] }[],
) {
  return envelope("history", {
    history: [
      {
        metadata: { phase: 0, chunk_order: 1, progress: 100 },
        threads: threads.map((t) => ({
          id: t.id,
          messages: t.messages.map((m) => ({
            from: m.from,
            id: m.id,
            timestamp: ts(m.at),
            type: "text",
            text: { body: m.text },
            history_context: { status: "READ" },
          })),
        })),
      },
    ],
  });
}

/** Delivery receipts for messages LUME sent (W3a): read by `readStatuses`, never by `readWebhook`. */
export const statuses = (o: { id?: string; status?: string; at?: string; code?: number } = {}) =>
  envelope("messages", {
    statuses: [
      {
        id: o.id ?? "wamid.OUT1",
        status: o.status ?? "read",
        timestamp: ts(o.at ?? "2026-10-21T06:06:00Z"),
        recipient_id: "919876543210",
        ...(o.code ? { errors: [{ code: o.code, title: "Message failed" }] } : {}),
      },
    ],
  });
