"use client";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import s from "./scroll-rail.module.css";

type Thumb = { left: number; width: number } | null;

/**
 * A slim sideways scrollbar for a strip or table that scrolls across: a quiet track with a thumb the size of what's
 * in view, there only when something is out of view. Drag the thumb, or click the track to move a view's width.
 * The element itself keeps its own scrolling (trackpads, Shift + wheel, focus); the rail follows it.
 */
export function ScrollRail({
  target,
  className,
  label,
}: {
  target: RefObject<HTMLElement | null>;
  className?: string;
  /** What scrolls, for the rail's title ("Scroll the stages"). */
  label?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<Thumb>(null);
  const el = useTarget(target);

  useEffect(() => {
    if (!el) return;
    const measure = () => {
      const t = track.current;
      const room = el.scrollWidth - el.clientWidth;
      if (room <= 1 || !t) return setThumb(null);
      const w = t.clientWidth;
      const width = Math.max(28, (el.clientWidth / el.scrollWidth) * w);
      setThumb({ width, left: (el.scrollLeft / room) * (w - width) });
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    if (track.current) ro?.observe(track.current);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, [el]);

  /** The thumb follows the pointer 1:1, from where it was grabbed. */
  const grab = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = target.current;
    const t = track.current;
    if (!el || !t || !thumb) return;
    e.preventDefault();
    e.stopPropagation();
    const node = e.currentTarget;
    node.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startScroll = el.scrollLeft;
    const ratio = (el.scrollWidth - el.clientWidth) / Math.max(1, t.clientWidth - thumb.width);
    const move = (ev: PointerEvent) => {
      el.scrollLeft = startScroll + (ev.clientX - startX) * ratio;
    };
    const up = () => {
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
  };
  /** A click on the track moves a view's width towards it. */
  const page = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = target.current;
    const t = track.current;
    if (!el || !t || !thumb) return;
    const x = e.clientX - t.getBoundingClientRect().left;
    const dir = x < thumb.left ? -1 : x > thumb.left + thumb.width ? 1 : 0;
    if (dir) el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: "smooth" });
  };

  return (
    <div
      ref={track}
      className={[s.rail, className].filter(Boolean).join(" ")}
      data-shown={thumb ? "" : undefined}
      aria-hidden
      title={label}
      onPointerDown={page}
    >
      {thumb && (
        <div
          className={s.thumb}
          data-testid="scroll-thumb"
          style={{ width: thumb.width, transform: `translateX(${thumb.left}px)` }}
          onPointerDown={grab}
        />
      )}
    </div>
  );
}

/**
 * A mouse wheel scrolls a sideways strip across while the strip has further to go that way, and the page as usual
 * once it reaches an end. Trackpads already scroll across; this is for the wheel.
 */
export function useWheelAcross(target: RefObject<HTMLElement | null>) {
  const el = useTarget(target);
  useEffect(() => {
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) >= Math.abs(e.deltaY) || e.ctrlKey) return;
      const room = el.scrollWidth - el.clientWidth;
      if (room <= 1) return;
      const atStart = el.scrollLeft <= 0 && e.deltaY < 0;
      const atEnd = el.scrollLeft >= room - 1 && e.deltaY > 0;
      if (atStart || atEnd) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [el]);
}

/** The element a ref points at, followed as it comes and goes (a table that appears once its rows load). */
function useTarget(target: RefObject<HTMLElement | null>) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (target.current !== el) setEl(target.current);
  });
  return el;
}
