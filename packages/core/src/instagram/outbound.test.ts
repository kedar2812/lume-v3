import { describe, expect, it } from "vitest";
import { igOutboundBody, refusalOfIg } from "./outbound";

/** What LUME sends to Instagram's Send API, and Meta's refusals in words (plan 1A Task 1). */
describe("igOutboundBody", () => {
  it("words to a person", () => {
    expect(igOutboundBody({ igsid: "1" }, { text: "Hello" })).toEqual({
      recipient: { id: "1" },
      message: { text: "Hello" },
    });
  });

  it("a private reply goes to the comment", () => {
    expect(igOutboundBody({ commentId: "C1" }, { text: "Here's the guide" })).toEqual({
      recipient: { comment_id: "C1" },
      message: { text: "Here's the guide" },
    });
  });

  it("quick replies are text quick replies", () => {
    expect(
      igOutboundBody({ igsid: "1" }, { text: "Pick", quickReplies: [{ title: "Yes", payload: "y" }] }),
    ).toEqual({
      recipient: { id: "1" },
      message: { text: "Pick", quick_replies: [{ content_type: "text", title: "Yes", payload: "y" }] },
    });
  });

  it("link buttons are a button template", () => {
    expect(
      igOutboundBody(
        { igsid: "1" },
        { text: "Book here", buttons: [{ title: "Book", url: "https://b.test/x" }] },
      ),
    ).toEqual({
      recipient: { id: "1" },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "button",
            text: "Book here",
            buttons: [{ type: "web_url", url: "https://b.test/x", title: "Book" }],
          },
        },
      },
    });
  });

  it("a file is an attachment by its link", () => {
    expect(
      igOutboundBody({ igsid: "1" }, { text: null, mediaUrl: "https://f.test/a.jpg", mediaKind: "image" }),
    ).toEqual({
      recipient: { id: "1" },
      message: { attachment: { type: "image", payload: { url: "https://f.test/a.jpg" } } },
    });
  });

  it("a person's reply after 24 hours carries the human agent tag", () => {
    expect(igOutboundBody({ igsid: "1" }, { text: "Sorry for the wait" }, "HUMAN_AGENT")).toEqual({
      recipient: { id: "1" },
      messaging_type: "MESSAGE_TAG",
      tag: "HUMAN_AGENT",
      message: { text: "Sorry for the wait" },
    });
  });
});

describe("refusalOfIg", () => {
  const err = (code: number, sub?: number) => ({
    error: { code, ...(sub ? { error_subcode: sub } : {}), message: "x" },
  });
  it("a token Meta no longer takes", () => {
    expect(refusalOfIg(400, err(190))).toMatchObject({ code: "TOKEN", token: true, retry: false });
  });
  it("rate limits are tried again later", () => {
    for (const c of [4, 17, 32, 613, 80002])
      expect(refusalOfIg(400, err(c))).toMatchObject({ code: "BUSY", retry: true });
  });
  it("outside the window, or the person can't be reached, is final", () => {
    expect(refusalOfIg(400, err(10, 2534022))).toMatchObject({ code: "WINDOW", retry: false });
    expect(refusalOfIg(400, err(551))).toMatchObject({ code: "UNAVAILABLE", retry: false });
    expect(refusalOfIg(400, err(100))).toMatchObject({ code: "REFUSED", retry: false });
  });
  it("Meta down or an answer LUME can't read is tried again", () => {
    expect(refusalOfIg(503, null)).toMatchObject({ code: "META_DOWN", retry: true });
    expect(refusalOfIg(0, null)).toMatchObject({ code: "META_DOWN", retry: true });
    expect(refusalOfIg(400, "<html>")).toMatchObject({ code: "REFUSED", retry: false });
  });
  it("every refusal has words for a person", () => {
    for (const r of [
      refusalOfIg(400, err(190)),
      refusalOfIg(400, err(4)),
      refusalOfIg(400, err(10, 2534022)),
      refusalOfIg(503, null),
    ])
      expect(r.words).toMatch(/\w.*\./);
  });
});
