const graphemes = (s: string): string[] => {
  try {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].map((g) => g.segment);
  } catch {
    return [...s];
  }
};
/** A visible character that is a letter or a digit (an emoji, a bracket or a + is not). */
const isAlnum = (g: string) => /^[\p{L}\p{N}]/u.test(g);

/**
 * The initials LUME draws on an avatar: the first letter of the first and last word ("Ananya Rao" → "AR"), or the
 * first two of a single word. Whole characters only — an emoji is never split into a broken half, an Indic letter
 * keeps its vowel sign — and words with no letter (an emoji, a bracket) are skipped. "?" when nothing is left.
 */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .map((w) => graphemes(w).filter(isAlnum))
    .filter((w) => w.length > 0);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).join("").toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}
