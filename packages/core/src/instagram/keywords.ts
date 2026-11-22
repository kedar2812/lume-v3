/**
 * Keywords that start a flow (NEW_FEATURES_PLAN §4.5): whole words in any script, case ignored, Latin accents ignored
 * ("café" = "CAFE"). Only Latin accents go: a Devanagari vowel sign is part of the word ("कम" is not "काम").
 */
export type KeywordMode = "word" | "exact" | "any";

const LATIN_MARKS = /[̀-ͯ]/g;
/** Letters, marks and digits make a word; everything else (spaces, punctuation, emoji, #) separates words. */
const WORD = /[\p{L}\p{M}\p{N}]+/gu;

export const foldKeyword = (s: string): string =>
  s.normalize("NFD").replace(LATIN_MARKS, "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

const words = (s: string) => foldKeyword(s).match(WORD) ?? [];

function containsRun(hay: string[], needle: string[]): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * The first keyword (in the list's order) the text matches, as written in the list; "" for `any` on any words; null
 * when nothing matches. A keyword with no letters or digits (an emoji) matches anywhere in the text.
 */
export function matchKeyword(text: string | null, keywords: string[], mode: KeywordMode): string | null {
  if (!text || !text.trim()) return null;
  if (mode === "any") return "";
  const folded = foldKeyword(text);
  const textWords = words(text);
  for (const k of keywords) {
    const kf = foldKeyword(k);
    if (!kf) continue;
    const kw = words(k);
    if (mode === "exact") {
      if (kw.length ? textWords.join(" ") === kw.join(" ") : folded === kf) return k;
      continue;
    }
    if (kw.length ? containsRun(textWords, kw) : folded.includes(kf)) return k;
  }
  return null;
}
