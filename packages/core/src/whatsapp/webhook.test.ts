import { describe, expect, it } from "vitest";
import { echo, envelope, history, inbound, PHONE_NUMBER_ID, statuses } from "./fixtures";
import { readStatuses, readWebhook } from "./webhook";

/** Meta's deliveries as LUME reads them (spec 2026-10-18 §4.1; plan W1 Task 1). */
describe("reading Meta's WhatsApp webhooks", () => {
  it("a text reply: who, to which number, when, and what they said", () => {
    expect(readWebhook(inbound())).toEqual([
      {
        kind: "received",
        phoneNumberId: PHONE_NUMBER_ID,
        peer: "+919876543210",
        wamid: "wamid.IN1",
        at: "2026-10-21T06:00:00.000Z",
        text: "Yes, Saturday works",
        media: null,
        name: "Sneha Reddy",
      },
    ]);
  });

  it("a photo with its caption, a voice note and a document keep their media", () => {
    const [photo] = readWebhook(
      inbound({
        type: "image",
        image: { id: "M1", mime_type: "image/jpeg", sha256: "x", caption: "Our hall" },
      }),
    );
    expect(photo).toMatchObject({
      text: "Our hall",
      media: {
        id: "M1",
        kind: "image",
        mime: "image/jpeg",
        filename: null,
        caption: "Our hall",
        voice: false,
      },
    });
    const [voice] = readWebhook(
      inbound({ type: "audio", audio: { id: "M2", mime_type: "audio/ogg", voice: true } }),
    );
    expect(voice).toMatchObject({ text: null, media: { id: "M2", kind: "audio", voice: true } });
    const [doc] = readWebhook(
      inbound({
        type: "document",
        document: { id: "M3", mime_type: "application/pdf", filename: "Floor plan.pdf" },
      }),
    );
    expect(doc).toMatchObject({
      media: { kind: "document", filename: "Floor plan.pdf", mime: "application/pdf" },
    });
  });

  it("what LUME can't show is said in words, never dropped", () => {
    expect(
      readWebhook(inbound({ type: "location", location: { latitude: 17.4, longitude: 78.4 } }))[0]!.text,
    ).toBe("Sent a location");
    expect(
      readWebhook(inbound({ type: "reaction", reaction: { message_id: "wamid.OUT1", emoji: "👍" } }))[0]!
        .text,
    ).toBe("Reacted 👍");
    expect(readWebhook(inbound({ type: "unsupported" }))[0]!.text).toBe(
      "Sent a message LUME can't show. Open it on the phone.",
    );
  });

  it("a message sent from the business's phone is 'sent', to the lead", () => {
    expect(readWebhook(echo())).toEqual([
      expect.objectContaining({
        kind: "sent",
        peer: "+919876543210",
        wamid: "wamid.OUT1",
        text: "See you Saturday",
        name: null,
      }),
    ]);
  });

  it("past chats: the thread is the lead; who wrote each one decides its direction", () => {
    const events = readWebhook(
      history([
        {
          id: "919876543210",
          messages: [
            { from: "919876543210", id: "wamid.H1", at: "2026-10-01T10:00:00Z", text: "Hi, saw your ad" },
            {
              from: "919000000001",
              id: "wamid.H2",
              at: "2026-10-01T10:05:00Z",
              text: "Hello! What do you need?",
            },
          ],
        },
      ]),
    );
    expect(events.map((e) => [e.kind, e.peer, e.wamid])).toEqual([
      ["history_received", "+919876543210", "wamid.H1"],
      ["history_sent", "+919876543210", "wamid.H2"],
    ]);
  });

  it("receipts only, and anything malformed, are nothing — never a throw", () => {
    expect(readWebhook(statuses())).toEqual([]);
    for (const bad of [
      null,
      {},
      { entry: 5 },
      { entry: [{ changes: [{ field: "messages", value: 7 }] }] },
      "x",
    ])
      expect(readWebhook(bad)).toEqual([]);
  });

  it("one bad change never drops the good ones beside it", () => {
    const good = inbound();
    const body = {
      ...good,
      entry: [...good.entry, { id: "x", changes: [{ field: "messages", value: { messages: [{ id: 3 }] } }] }],
    };
    expect(readWebhook(body)).toHaveLength(1);
  });

  it("an unknown field is ignored", () => {
    expect(readWebhook(envelope("account_update", { event: "VERIFIED" }))).toEqual([]);
  });
});

/** Delivery receipts for what LUME sent (plan W3a Task 1). */
describe("reading Meta's delivery statuses", () => {
  it("a status: which message, to whom, what happened and when", () => {
    expect(readStatuses(statuses())).toEqual([
      {
        phoneNumberId: PHONE_NUMBER_ID,
        wamid: "wamid.OUT1",
        peer: "+919876543210",
        status: "read",
        at: "2026-10-21T06:06:00.000Z",
        errorCode: null,
      },
    ]);
  });

  it("a failed one carries Meta's error code", () => {
    expect(readStatuses(statuses({ status: "failed", code: 131047 }))).toMatchObject([
      { status: "failed", errorCode: 131047 },
    ]);
  });

  it("a status LUME doesn't know, messages, and anything malformed are nothing — never a throw", () => {
    expect(readStatuses(statuses({ status: "deleted" }))).toEqual([]);
    expect(readStatuses(inbound())).toEqual([]);
    for (const bad of [
      null,
      {},
      "x",
      { entry: [{ changes: [{ field: "messages", value: { statuses: 5 } }] }] },
    ])
      expect(readStatuses(bad)).toEqual([]);
  });
});
