import type { PdfTextItem } from "./pdf";

/**
 * Find in a PDF (owner, 2026-10-25): a page's text as a person reads it, not as the file stores it. A PDF keeps a line in
 * pieces (a word, part of a word, a run of words), so the pieces are joined as they sit on the page: a space where
 * there's a gap or a new line, none where they touch, and a word hyphenated across lines joined again. Capitals, runs
 * of spaces and ligatures (ﬁ, ﬂ) are folded, so they never stop a match. Every character keeps where it came from, so
 * a match lights up the right words, even across pieces.
 */
export type PageIndex = {
  /** Folded: lower case, ligatures opened, one space between words. */
  text: string;
  /** For each character of `text`, the piece and the character in it; null for a space LUME put between pieces. */
  from: ({ item: number; at: number } | null)[];
};
/** One match: the part of each piece it covers. */
export type FoundPart = { item: number; start: number; length: number };

const fold = (s: string) => s.normalize("NFKC").toLowerCase();
const space = /\s/;
/** The gap (as a share of the text's height) past which two pieces on a line are two words. */
const WORD_GAP = 0.15;

export function indexPage(items: PdfTextItem[]): PageIndex {
  let text = "";
  const from: PageIndex["from"] = [];
  const push = (ch: string, at: { item: number; at: number } | null) => {
    if (space.test(ch)) {
      // One space between words, never at the start.
      if (!text || text.endsWith(" ")) return;
      text += " ";
      from.push(at);
      return;
    }
    text += ch;
    from.push(at);
  };
  items.forEach((it, i) => {
    const prev = i > 0 ? items[i - 1]! : null;
    if (prev) {
      const h = prev.height || Math.abs(prev.transform[3] ?? 12) || 12;
      const newLine = !!prev.hasEOL || Math.abs((it.transform[5] ?? 0) - (prev.transform[5] ?? 0)) > h * 0.5;
      if (newLine && /-$/.test(prev.str.trimEnd()) && /^\p{L}/u.test(it.str) && text.endsWith("-")) {
        // "kit-" at a line's end and "chens" on the next: one word again.
        text = text.slice(0, -1);
        from.pop();
      } else if (newLine) push(" ", null);
      else {
        const gap = (it.transform[4] ?? 0) - ((prev.transform[4] ?? 0) + prev.width);
        if (gap > h * WORD_GAP) push(" ", null);
      }
    }
    [...it.str].forEach((c, k) => {
      for (const ch of fold(c)) push(ch, { item: i, at: k });
    });
  });
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    from.pop();
  }
  return { text, from };
}

/** Every match of `query` on the page, in order, each as the parts of the pieces it covers. */
export function findIn(page: PageIndex, query: string): FoundPart[][] {
  const q = fold(query).replace(/\s+/g, " ").trim();
  if (!q) return [];
  const out: FoundPart[][] = [];
  for (let s = page.text.indexOf(q); s >= 0; s = page.text.indexOf(q, s + q.length)) {
    const parts: FoundPart[] = [];
    for (const f of page.from.slice(s, s + q.length)) {
      if (!f) continue;
      const last = parts.at(-1);
      if (last && last.item === f.item) last.length = Math.max(last.length, f.at - last.start + 1);
      else parts.push({ item: f.item, start: f.at, length: 1 });
    }
    out.push(parts);
  }
  return out;
}
