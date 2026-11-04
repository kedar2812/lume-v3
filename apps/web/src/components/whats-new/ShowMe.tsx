"use client";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Story } from "@lume/core/shared";
import { Spotlight } from "@/components/tour/Spotlight";
import { BodyPortal } from "@/components/ui/BodyPortal";
import { cardPosition, type RectLike, type Viewport } from "@/lib/spotlight";
import { StoryMark, kickerLabel } from "./StoryMark";
import s from "./whats-new.module.css";

/** How long Show me looks for the control before it says its piece in the middle instead. */
export const SHOW_ME_WAIT_MS = 3000;
/** The tip's size until it has been measured. */
export const TIP = { width: 320, height: 180 };
const POLL_MS = 100;

const findTarget = (t: string) =>
  document.querySelector<HTMLElement>(`[data-whatsnew="${t}"], [data-tour="${t}"]`);
/** A control that isn't on screen (missing, or hidden at this width) is never pointed at. */
const isShown = (el: HTMLElement | null): el is HTMLElement =>
  !!el && (typeof el.checkVisibility !== "function" || el.checkVisibility());
const viewport = (): Viewport => ({ width: window.innerWidth, height: window.innerHeight });

/**
 * Show me (spec 2026-11-02): on the story's own page, a spotlight with a ring on the control and a tip beside it, below
 * it or above it when there's no room, never over it. A control that doesn't appear within 3 s (still loading, or not
 * there for this person) gets no spotlight on nothing: the tip sits in the middle.
 */
export function ShowMe({
  story,
  onGotIt,
  onBack,
}: {
  story: Story;
  onGotIt: () => void;
  onBack: () => void;
}) {
  const [rect, setRect] = useState<RectLike | null>(null);
  const [phase, setPhase] = useState<"looking" | "found" | "centred">("looking");
  const [vp, setVp] = useState<Viewport>({ width: 0, height: 0 });
  const [size, setSize] = useState(TIP);
  const tip = useRef<HTMLDivElement>(null);
  const ok = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let el: HTMLElement | null = null;
    let waited = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watch: ReturnType<typeof setInterval> | undefined;
    let last = "";
    const measure = () => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vp = viewport();
      const key = `${r.top}|${r.left}|${r.width}|${r.height}|${vp.width}|${vp.height}`;
      if (key === last) return;
      last = key;
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      setVp(vp);
    };
    const look = () => {
      const found = findTarget(story.place.target);
      if (isShown(found)) {
        el = found;
        el.scrollIntoView?.({ block: "center", inline: "nearest" });
        measure();
        setPhase("found");
        // The page may still be settling (a section loading above the control): the ring follows it.
        watch = setInterval(measure, POLL_MS);
        return;
      }
      waited += POLL_MS;
      if (waited >= SHOW_ME_WAIT_MS) {
        setVp(viewport());
        setPhase("centred");
        return;
      }
      timer = setTimeout(look, POLL_MS);
    };
    timer = setTimeout(look, POLL_MS);
    window.addEventListener("resize", measure, { passive: true });
    window.addEventListener("scroll", measure, { passive: true, capture: true });
    return () => {
      clearTimeout(timer);
      clearInterval(watch);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, { capture: true });
    };
  }, [story.place.target]);

  useLayoutEffect(() => {
    if (phase === "looking") return;
    const w = tip.current?.offsetWidth;
    const h = tip.current?.offsetHeight;
    if (w && h && (w !== size.width || h !== size.height)) setSize({ width: w, height: h });
    ok.current?.focus({ preventScroll: true });
  }, [phase, size.width, size.height]);

  if (phase === "looking") return null;
  const centred = phase === "centred" || !rect;
  const at = centred
    ? { top: Math.max(12, (vp.height - size.height) / 2), left: Math.max(12, (vp.width - size.width) / 2) }
    : cardPosition(rect, "bottom", size, vp);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") onGotIt();
  };

  return (
    <BodyPortal>
      <Spotlight rect={centred ? null : rect} viewport={vp} onClick={onGotIt} />
      <div
        ref={tip}
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-tip"
        className={s.tip}
        data-centred={centred || undefined}
        style={{ top: `${at.top}px`, left: `${at.left}px` }}
        onKeyDown={onKeyDown}
      >
        <span className={s.tipKicker}>
          <StoryMark kicker={story.kicker} size={16} />
          {kickerLabel(story.kicker)}
        </span>
        <b id="whats-new-tip">{story.tip.title}</b>
        <p>{story.tip.body}</p>
        <div className={s.tipRow}>
          <button type="button" className={s.tipBack} onClick={onBack}>
            Back to What&apos;s new
          </button>
          <button ref={ok} type="button" className={s.tipOk} onClick={onGotIt}>
            Got it
          </button>
        </div>
      </div>
    </BodyPortal>
  );
}
