/**
 * How much of a message LUME AI is writing shows at `now` (spec 2026-10-19 §2: the real text arrives whole; the screen
 * reveals it at reading speed between `startedAt` and `revealedBy`). Whole words only, so nothing half-typed ever reads
 * as a different word, and an emoji or a joined script is never split. A paused run passes the moment it paused as
 * `now`, so the text freezes where it was.
 */
export function revealed(text: string, startedAt: Date, revealedBy: Date, now: Date): string {
  const span = revealedBy.getTime() - startedAt.getTime();
  if (span <= 0 || now.getTime() >= revealedBy.getTime()) return text;
  const share = (now.getTime() - startedAt.getTime()) / span;
  if (share <= 0) return "";
  const upTo = Math.floor(share * text.length);
  // The last gap between words at or before `upTo`: everything before it shows.
  for (let i = Math.min(upTo, text.length - 1); i > 0; i--)
    if (/\s/.test(text[i]!)) return text.slice(0, i).trimEnd();
  return "";
}
