/**
 * Forgiving search for short lists (settings, commands, pages): every word typed must find a word it starts, sits
 * inside, or misses by one letter (two for long words); initials and run-together letters count too. Scores favour a
 * title that starts with what was typed, then whole-word starts, then keywords, then typos.
 */
const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const words = (s: string) => norm(s).split(" ").filter(Boolean);

/** Optimal string alignment distance (a swap of two letters counts once), stopped early past `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array<number>(b.length).fill(0),
  ]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      best = Math.min(best, v);
    }
    if (best > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

/** How well one typed word fits one word of the text (0: not at all). */
function fit(q: string, w: string): number {
  if (w.startsWith(q)) return 4;
  if (q.length >= 3 && w.includes(q)) return 2.5;
  if (q.length < 4) return 0;
  const max = q.length >= 7 ? 2 : 1;
  // A slip anywhere in the word, or in the part of it typed so far.
  if (distance(q, w, max) <= max || distance(q, w.slice(0, q.length), max) <= max) return 1.5;
  return 0;
}

const initials = (ws: string[]) => ws.map((w) => w[0]).join("");

/** A score for `query` against a title and its keywords, or null when it doesn't match. */
export function fuzzyScore(query: string, title: string, keywords: string[] = []): number | null {
  const q = words(query);
  if (!q.length) return null;
  const tw = words(title);
  const kw = keywords.flatMap(words);
  const joined = q.join("");
  let total = 0;
  for (const part of q) {
    const inTitle = Math.max(0, ...tw.map((w) => fit(part, w)));
    const inKeys = Math.max(0, ...kw.map((w) => fit(part, w))) * 0.6;
    const best = Math.max(inTitle, inKeys);
    if (best === 0) {
      // "wh" for Working hours; "lostreason" for Lost reasons.
      const flat = tw.join("");
      if (part.length >= 2 && initials(tw).startsWith(part)) total += 2;
      else if (part.length >= 4 && flat.startsWith(part)) total += 3;
      else if (q.length === 1 && joined.length >= 4 && fit(joined, flat) > 0) total += 1.5;
      else return null;
    } else total += best;
  }
  if (norm(title).startsWith(q.join(" "))) total += 3;
  return total;
}

/** The items that match, best first; ties keep their order. */
export function fuzzyRank<T>(
  query: string,
  items: T[],
  of: (item: T) => { label: string; keywords?: string[] },
): T[] {
  if (!query.trim()) return [];
  return items
    .map((item, i) => {
      const { label, keywords } = of(item);
      return { item, i, score: fuzzyScore(query, label, keywords ?? []) };
    })
    .filter((x): x is { item: T; i: number; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.item);
}
