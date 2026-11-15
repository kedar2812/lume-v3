"use client";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BodyPortal } from "@/components/ui/BodyPortal";

/**
 * A panel that stays with its item (spec: Your day full screen): fixed on screen where `place` says, and placed again
 * — at most once a frame — whenever anything scrolls or the window resizes. Only the panel redraws, not the timeline.
 */
export function Floating({
  el,
  place,
  children,
}: {
  el: HTMLElement;
  place: (el: HTMLElement) => CSSProperties;
  children: (style: CSSProperties) => ReactNode;
}) {
  const [, setMoved] = useState(0);
  useEffect(() => {
    let frame = 0;
    const onMove = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setMoved((n) => n + 1);
      });
    };
    window.addEventListener("scroll", onMove, { capture: true, passive: true });
    window.addEventListener("resize", onMove);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onMove, { capture: true });
      window.removeEventListener("resize", onMove);
    };
  }, []);
  // Inside a dialog (the full screen) it goes into the dialog itself: outside an aria-modal dialog a screen reader
  // would not reach it, and the dialog's Tab order would not include it.
  const dialog = el.closest<HTMLElement>('[role="dialog"]');
  return dialog ? createPortal(children(place(el)), dialog) : <BodyPortal>{children(place(el))}</BodyPortal>;
}
