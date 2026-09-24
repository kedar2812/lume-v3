import { clipPathFor, type RectLike, type Viewport } from "@/lib/spotlight";
import s from "./tour.module.css";

const PAD = 8;
const RADIUS = 14;

/**
 * The veil blurs everything except one sharp, rounded hole over the target, and an accent ring marks
 * it. Clicking the veil moves on, like tapping through slides. Hidden from assistive tech: the card
 * says everything the picture does.
 */
export function Spotlight({
  rect,
  viewport,
  onClick,
}: {
  rect: RectLike | null;
  viewport: Viewport;
  onClick: () => void;
}) {
  const clip = rect && viewport.width ? clipPathFor(rect, PAD, RADIUS, viewport) : undefined;
  return (
    <>
      <div className={s.veil} style={clip ? { clipPath: clip } : undefined} onClick={onClick} aria-hidden />
      {rect && (
        <div
          className={s.ring}
          aria-hidden
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
          }}
        />
      )}
    </>
  );
}
