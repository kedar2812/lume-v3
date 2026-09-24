"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TourStep } from "@lume/core/shared";
import { cardPosition, type RectLike } from "@/lib/spotlight";
import { Spotlight } from "./Spotlight";
import { TourCard } from "./TourCard";

const CARD = { width: 330, height: 180 }; // until the card has been measured

/** Keeps the hole on the target as the page scrolls or resizes, and drives the tour from the keyboard. */
export function TourOverlay({
  step,
  index,
  total,
  onBack,
  onNext,
  onSkip,
}: {
  step: TourStep;
  index: number;
  total: number;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}) {
  const [rect, setRect] = useState<RectLike | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const card = useRef<HTMLDivElement>(null);
  const [cardSize, setCardSize] = useState(CARD);

  useLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el?.getBoundingClientRect();
        setRect(r ? { top: r.top, left: r.left, width: r.width, height: r.height } : null);
        setViewport({ width: window.innerWidth, height: window.innerHeight });
        if (card.current)
          setCardSize({
            width: card.current.offsetWidth || CARD.width,
            height: card.current.offsetHeight || CARD.height,
          });
      });
    };
    measure();
    window.addEventListener("resize", measure, { passive: true });
    window.addEventListener("scroll", measure, { passive: true, capture: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, { capture: true });
    };
  }, [step.target]);

  // Each step announces itself: focus moves to the card (never a visible ring on the card itself).
  useEffect(() => card.current?.focus({ preventScroll: true }), [index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onSkip();
      if (e.key === "ArrowRight") return (e.preventDefault(), onNext());
      if (e.key === "ArrowLeft") return (e.preventDefault(), onBack());
      // Enter on a focused button already means that button.
      const onControl =
        e.target instanceof HTMLElement && e.target.closest("button, a, input, select, textarea");
      if (e.key === "Enter" && !onControl) return (e.preventDefault(), onNext());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack, onNext, onSkip]);

  const place = rect && viewport.width ? cardPosition(rect, step.placement, cardSize, viewport) : null;
  return (
    <>
      <Spotlight rect={rect} viewport={viewport} onClick={onNext} />
      <TourCard
        ref={card}
        step={step}
        index={index}
        total={total}
        position={place}
        onBack={onBack}
        onNext={onNext}
        onSkip={onSkip}
      />
    </>
  );
}
