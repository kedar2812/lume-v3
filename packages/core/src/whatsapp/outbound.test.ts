import { describe, expect, it } from "vitest";
import { outboundBody, refusalOf, STATUS_RANK } from "./outbound";

/** What LUME sends to Meta for a reply from LUME, and Meta's refusals in words (plan W3a Task 1). */
describe("outboundBody", () => {
  it("text: to the lead's number, as one individual message, links shown", () => {
    expect(outboundBody("+919876543210", { text: "See you Saturday" })).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "919876543210",
      type: "text",
      text: { body: "See you Saturday", preview_url: true },
    });
  });

  it("a file by Meta's media id, with its caption and a document's name", () => {
    expect(
      outboundBody("+919876543210", {
        kind: "document",
        mediaId: "M9",
        caption: "Our prices",
        filename: "Prices.pdf",
      }),
    ).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "919876543210",
      type: "document",
      document: { id: "M9", caption: "Our prices", filename: "Prices.pdf" },
    });
    expect(
      outboundBody("+919876543210", { kind: "image", mediaId: "M1", caption: "The hall" }),
    ).toMatchObject({
      type: "image",
      image: { id: "M1", caption: "The hall" },
    });
  });

  it("audio never carries a caption (Meta refuses one); no caption, no empty field", () => {
    expect(outboundBody("+919876543210", { kind: "audio", mediaId: "A1", caption: "ignored" })).toMatchObject(
      {
        type: "audio",
        audio: { id: "A1" },
      },
    );
    expect(outboundBody("+919876543210", { kind: "image", mediaId: "M1" }).image).toEqual({ id: "M1" });
  });
});

describe("refusalOf", () => {
  it("each refusal in words: whether to try again, and whether the token is the trouble", () => {
    expect(refusalOf(131047)).toEqual({
      words: "WhatsApp's 24 hours since the lead's last message had passed. Send it from the phone.",
      retry: false,
      token: false,
    });
    expect(refusalOf(131026)).toMatchObject({
      retry: false,
      words: "This number can't get WhatsApp messages.",
    });
    expect(refusalOf(131051)).toMatchObject({
      retry: false,
      words: "WhatsApp doesn't take this kind of message.",
    });
    expect(refusalOf(131053)).toMatchObject({ retry: false, words: "WhatsApp couldn't read this file." });
    expect(refusalOf(130472)).toMatchObject({ retry: false, words: "WhatsApp held this message back." });
    expect(refusalOf(190)).toMatchObject({ token: true, retry: false });
    for (const code of [130429, 131056, 131000, 2, 4]) expect(refusalOf(code)).toMatchObject({ retry: true });
    expect(refusalOf(null)).toEqual({
      words: "WhatsApp didn't take this message. Try again.",
      retry: true,
      token: false,
    });
    expect(refusalOf(99999)).toMatchObject({
      retry: false,
      words: "WhatsApp didn't take this message. Try again.",
    });
  });
});

describe("STATUS_RANK", () => {
  it("moves only forward: queued, sending, sent, delivered, read", () => {
    const order = Object.entries(STATUS_RANK)
      .sort((a, b) => a[1] - b[1])
      .map(([k]) => k);
    expect(order).toEqual(["queued", "sending", "sent", "delivered", "read"]);
  });
});
