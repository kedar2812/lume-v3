/** Geometry for the spotlight tour (spec §5): the hole in the veil and where the card goes. Pure. */
export type RectLike = { top: number; left: number; width: number; height: number };
export type Viewport = { width: number; height: number };

const CARD_GAP = 16;
const EDGE = 12;
const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/**
 * A blurred veil with a rounded hole: one `path(evenodd, …)` of the whole viewport plus the hole, so the
 * highlighted element stays perfectly sharp while everything else is blurred. The hole never leaves the
 * screen, and its corners never exceed half its size.
 */
export function clipPathFor(rect: RectLike, pad: number, radius: number, vp: Viewport): string {
  const x = clamp(rect.left - pad, 0, vp.width);
  const y = clamp(rect.top - pad, 0, vp.height);
  const w = clamp(rect.left + rect.width + pad, 0, vp.width) - x;
  const h = clamp(rect.top + rect.height + pad, 0, vp.height) - y;
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const n = (v: number) => Math.round(v);
  const hole =
    `M${n(x + r)} ${n(y)}H${n(x + w - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)}` +
    `V${n(y + h - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w - r)} ${n(y + h)}` +
    `H${n(x + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y + h - r)}` +
    `V${n(y + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)}Z`;
  return `path(evenodd,"M0 0H${vp.width}V${vp.height}H0Z ${hole}")`;
}

/** Beside the target for sidebar items, below it for top-bar items, always fully on screen. */
export function cardPosition(
  rect: RectLike,
  placement: "right" | "bottom",
  card: { width: number; height: number },
  vp: Viewport,
): { top: number; left: number } {
  const maxLeft = Math.max(EDGE, vp.width - card.width - EDGE);
  const maxTop = Math.max(EDGE, vp.height - card.height - EDGE);
  if (placement === "right") {
    const beside = rect.left + rect.width + CARD_GAP + 2;
    const left = beside + card.width > vp.width - EDGE ? rect.left - card.width - CARD_GAP : beside;
    return { top: clamp(rect.top - 12, EDGE, maxTop), left: clamp(left, EDGE, maxLeft) };
  }
  const below = rect.top + rect.height + CARD_GAP;
  const top = below + card.height > vp.height - EDGE ? rect.top - card.height - CARD_GAP : below;
  return {
    top: clamp(top, EDGE, maxTop),
    left: clamp(rect.left + rect.width / 2 - card.width / 2, EDGE, maxLeft),
  };
}
