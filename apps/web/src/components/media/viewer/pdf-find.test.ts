import { describe, expect, it } from "vitest";
import type { PdfTextItem } from "./pdf";
import { findIn, indexPage } from "./pdf-find";

/** Find in a PDF (owner, 2026-10-25: "the find function does not work properly in pdfs"): a page's words as read. */
const item = (
  str: string,
  x: number,
  y = 700,
  o: { width?: number; hasEOL?: boolean } = {},
): PdfTextItem => ({
  str,
  transform: [12, 0, 0, 12, x, y],
  width: o.width ?? str.length * 6,
  height: 12,
  ...(o.hasEOL ? { hasEOL: true } : {}),
});

describe("a page's words, as a reader reads them", () => {
  it("a phrase in two pieces on one line, with a gap between them, is found as one", () => {
    const page = indexPage([item("modular", 72), item("kitchen", 72 + 42 + 4)]);
    expect(page.text).toBe("modular kitchen");
    expect(findIn(page, "modular kitchen")).toEqual([
      [
        { item: 0, start: 0, length: 7 },
        { item: 1, start: 0, length: 7 },
      ],
    ]);
  });

  it("a word the file split in two, touching, stays one word", () => {
    const page = indexPage([item("Kitch", 72), item("en", 72 + 30)]);
    expect(page.text).toBe("kitchen");
    expect(findIn(page, "kitchen")).toEqual([
      [
        { item: 0, start: 0, length: 5 },
        { item: 1, start: 0, length: 2 },
      ],
    ]);
  });

  it("the end of a line is a space; a word hyphenated across lines is joined again", () => {
    const lines = indexPage([item("modular", 72, 700, { hasEOL: true }), item("kitchens", 72, 686)]);
    expect(findIn(lines, "modular kitchens")).toHaveLength(1);
    const hyphen = indexPage([item("We design kit-", 72, 700, { hasEOL: true }), item("chens too", 72, 686)]);
    expect(hyphen.text).toBe("we design kitchens too");
    expect(findIn(hyphen, "kitchens")).toEqual([
      [
        { item: 0, start: 10, length: 3 },
        { item: 1, start: 0, length: 5 },
      ],
    ]);
  });

  it("capitals, extra spaces and the fi ligature never stop a match", () => {
    const page = indexPage([item("Free   SITE visit", 72), item("ﬁnish in 45 days", 72, 686)]);
    expect(findIn(page, "  site   VISIT ")).toHaveLength(1);
    expect(findIn(page, "finish")).toEqual([[{ item: 1, start: 0, length: 1 + 4 }]]);
  });

  it("every match on the page, in order; nothing for an empty search", () => {
    const page = indexPage([item("Price list: price per kitchen, price per wardrobe", 72)]);
    expect(findIn(page, "price")).toHaveLength(3);
    expect(findIn(page, "   ")).toEqual([]);
  });

  it("a page with no text at all says so", () => {
    expect(indexPage([]).text).toBe("");
    expect(indexPage([item("   ", 72)]).text).toBe("");
  });
});
