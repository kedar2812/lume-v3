import { describe, expect, it } from "vitest";
import { IG_LIMITS, messageProblems, textBytes } from "./limits";

/** Meta's limits on what LUME sends (read 2026-11-22): bytes, not characters. */
describe("Instagram message limits", () => {
  it("counts UTF-8 bytes", () => {
    expect(textBytes("abc")).toBe(3);
    expect(textBytes("😀")).toBe(4);
    expect(textBytes("क")).toBe(3);
    expect(IG_LIMITS.textBytes).toBe(1000);
  });

  it("allows exactly 1,000 bytes, in any script", () => {
    expect(messageProblems({ text: "a".repeat(1000) })).toEqual([]);
    expect(messageProblems({ text: "😀".repeat(250) })).toEqual([]);
    expect(messageProblems({ text: "क".repeat(333) })).toEqual([]);
  });

  it("refuses one byte more, in words", () => {
    for (const text of ["a".repeat(1001), "😀".repeat(251), "क".repeat(334)]) {
      const p = messageProblems({ text });
      expect(p).toHaveLength(1);
      expect(p[0]).toMatch(/too long for Instagram/);
    }
  });

  it("needs words or a file", () => {
    expect(messageProblems({ text: null })).toEqual(["Write a message or add a file."]);
    expect(messageProblems({ text: "   " })).toEqual(["Write a message or add a file."]);
    expect(messageProblems({ text: null, mediaUrl: "https://x.test/a.jpg", mediaKind: "image" })).toEqual([]);
  });

  it("allows 13 quick replies of up to 20 characters, never blank or repeated", () => {
    const qr = (n: number, title = "Yes") =>
      Array.from({ length: n }, (_, i) => ({ title: `${title}${i}`, payload: `p${i}` }));
    expect(messageProblems({ text: "Pick one", quickReplies: qr(13) })).toEqual([]);
    expect(messageProblems({ text: "Pick one", quickReplies: qr(14) })).toEqual([
      "Instagram allows at most 13 quick replies.",
    ]);
    expect(
      messageProblems({ text: "Pick", quickReplies: [{ title: "x".repeat(21), payload: "a" }] }),
    ).toEqual(["A quick reply can be at most 20 characters."]);
    expect(messageProblems({ text: "Pick", quickReplies: [{ title: " ", payload: "a" }] })).toEqual([
      "A quick reply needs words.",
    ]);
    expect(
      messageProblems({
        text: "Pick",
        quickReplies: [
          { title: "Yes", payload: "a" },
          { title: "yes", payload: "b" },
        ],
      }),
    ).toEqual(["Two quick replies say the same thing."]);
  });

  it("quick replies need words with them", () => {
    expect(
      messageProblems({
        text: null,
        mediaUrl: "https://x.test/a.jpg",
        mediaKind: "image",
        quickReplies: [{ title: "A", payload: "a" }],
      }),
    ).toEqual(["Quick replies go with words. Write a message too."]);
  });

  it("allows up to 3 link buttons with https links, with words up to 640 characters", () => {
    const b = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ title: `Open ${i}`, url: `https://example.test/${i}` }));
    expect(messageProblems({ text: "Here you go", buttons: b(3) })).toEqual([]);
    expect(messageProblems({ text: "Here", buttons: b(4) })).toEqual(["Instagram allows at most 3 buttons."]);
    expect(
      messageProblems({ text: "Here", buttons: [{ title: "Open", url: "http://example.test" }] }),
    ).toEqual(["A button's link must start with https://."]);
    expect(
      messageProblems({ text: "Here", buttons: [{ title: "Open", url: "javascript:alert(1)" }] }),
    ).toEqual(["A button's link must start with https://."]);
    expect(messageProblems({ text: "x".repeat(641), buttons: b(1) })).toEqual([
      "With buttons, the message can be at most 640 characters.",
    ]);
    expect(messageProblems({ text: "Here", buttons: [{ title: "", url: "https://example.test" }] })).toEqual([
      "A button needs words.",
    ]);
  });

  it("quick replies and buttons don't go together", () => {
    expect(
      messageProblems({
        text: "Pick",
        quickReplies: [{ title: "A", payload: "a" }],
        buttons: [{ title: "Open", url: "https://example.test" }],
      }),
    ).toEqual(["Use quick replies or buttons in one message, not both."]);
  });
});
