/** What React Flow measured of a card: carried on a new object so the card isn't measured again. */
export type Sized = { measured?: { width?: number; height?: number } };

/**
 * A card as it was when nothing about it changed (the same object, so React Flow keeps everything it knows of it);
 * otherwise the new one, with the size React Flow last measured while what's on it is unchanged (owner 2026-11-28,
 * "the cards are laggy": React Flow hides, re-measures and redraws the lines of any card handed over as a new object
 * without its size). A card whose words changed is measured again: its ways out may have moved.
 */
export function keepNode<T extends Sized & { id: string }>(
  cache: Map<string, T>,
  next: T,
  same: (a: T, b: T) => boolean,
  sizes: ReadonlyMap<string, { width: number; height: number }>,
): T {
  const was = cache.get(next.id);
  if (was && same(was, next)) return was;
  // Only while what's on the card is the same (a move, a select): new words may move its ways out, and React Flow
  // finds where they are only by measuring it (review 2026-11-28).
  const size =
    was && (was as { data?: unknown }).data === (next as { data?: unknown }).data
      ? sizes.get(next.id)
      : undefined;
  const made = size ? { ...next, measured: { width: size.width, height: size.height } } : next;
  cache.set(next.id, made);
  return made;
}
