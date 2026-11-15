"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { rubberband } from "@/lib/today/timeline-math";

/** Movement before a press becomes a drag (a smaller wobble is still a click). */
export const DRAG_PX = 6;
/** Velocity is read over the last this many ms of the drag. */
const SAMPLE_MS = 100;
/** Per-ms decay of a flick's speed: scroll-like deceleration (Apple's 0.998). */
const DECAY = 0.998;
/** Below this speed (px/s) a flick has stopped. */
const STOP_V = 10;

type Drag = {
  startX: number;
  startY: number;
  startLeft: number;
  startTop: number;
  moved: boolean;
  samples: { t: number; x: number }[];
};

/**
 * Drag to move (spec: Your day full screen, Timeline): a mouse or pen press that moves more than DRAG_PX moves the
 * timeline 1:1, carries the flick's speed when let go and slows to a stop, and resists softly past either end. Touch
 * keeps the browser's own scrolling; two fingers pinch to zoom. Ctrl + scroll (and a trackpad pinch) zooms too.
 */
export function usePanZoom(
  scroller: RefObject<HTMLElement | null>,
  canvas: RefObject<HTMLElement | null>,
  o: {
    /** The furthest it can scroll sideways, in px. */
    maxLeft: () => number;
    /** Zoom by `factor` keeping the time under `anchorX` (px from the scroller's left edge) in place. */
    zoom: (factor: number, anchorX: number) => void;
  },
) {
  const drag = useRef<Drag | null>(null);
  const suppress = useRef(false);
  const frame = useRef<number | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const opts = useRef(o);
  opts.current = o;

  const stop = useCallback(() => {
    if (frame.current != null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  const shift = (px: number) => {
    if (canvas.current) canvas.current.style.transform = px ? `translateX(${px}px)` : "";
  };

  /** Ease a rubber-band offset back to rest. */
  const settle = (from: number) => {
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 300);
      shift(from * (1 - (1 - (1 - k) ** 3)));
      frame.current = k < 1 ? requestAnimationFrame(step) : null;
    };
    frame.current = requestAnimationFrame(step);
  };

  /** Carry a flick of `v` px/s (along the pointer) on until it slows to a stop or meets an end. */
  const glide = (v: number) => {
    let last = performance.now();
    let speed = v;
    const step = () => {
      const el = scroller.current;
      if (!el) return;
      const now = performance.now();
      const dt = now - last;
      last = now;
      const next = el.scrollLeft - (speed * dt) / 1000;
      const max = opts.current.maxLeft();
      el.scrollLeft = Math.max(0, Math.min(max, next));
      speed *= DECAY ** dt;
      frame.current = Math.abs(speed) > STOP_V && next > 0 && next < max ? requestAnimationFrame(step) : null;
    };
    frame.current = requestAnimationFrame(step);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === "touch") {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.current.size === 2) {
        const [a, b] = [...touches.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
        pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
      }
      return;
    }
    if (e.button !== 0) return;
    const el = scroller.current;
    if (!el) return;
    stop();
    shift(0);
    drag.current = {
      startX: e.clientX,
      startY: e.clientY,
      startLeft: el.scrollLeft,
      startTop: el.scrollTop,
      moved: false,
      samples: [{ t: performance.now(), x: e.clientX }],
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === "touch") {
      if (!touches.current.has(e.pointerId)) return;
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.current.size === 2 && pinch.current) {
        const [a, b] = [...touches.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const left = scroller.current?.getBoundingClientRect().left ?? 0;
        opts.current.zoom(d / pinch.current.d, (a.x + b.x) / 2 - left);
        pinch.current = { d };
      }
      return;
    }
    const g = drag.current;
    const el = scroller.current;
    if (!g || !el) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!g.moved) {
      if (Math.hypot(dx, dy) < DRAG_PX) return;
      g.moved = true;
      setDragging(true);
      try {
        el.setPointerCapture?.(e.pointerId);
      } catch {
        // A pointer that already ended can't be captured; the drag still works while it's over the timeline.
      }
    }
    const now = performance.now();
    g.samples.push({ t: now, x: e.clientX });
    while (g.samples.length > 2 && now - g.samples[0]!.t > SAMPLE_MS) g.samples.shift();
    const left = g.startLeft - dx;
    const max = opts.current.maxLeft();
    const w = el.clientWidth || 1;
    el.scrollLeft = Math.max(0, Math.min(max, left));
    shift(left < 0 ? rubberband(-left, w) : left > max ? -rubberband(left - max, w) : 0);
    el.scrollTop = g.startTop - dy;
  };

  const end = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === "touch") {
      touches.current.delete(e.pointerId);
      if (touches.current.size < 2) pinch.current = null;
      return;
    }
    const g = drag.current;
    drag.current = null;
    if (!g?.moved) return;
    setDragging(false);
    suppress.current = true;
    setTimeout(() => (suppress.current = false), 400);
    const offset = canvas.current?.style.transform ? parseFloat(canvas.current.style.transform.slice(11)) : 0;
    if (offset) return settle(offset);
    const first = g.samples[0]!;
    const last = g.samples.at(-1)!;
    const v = last.t > first.t ? ((last.x - first.x) / (last.t - first.t)) * 1000 : 0;
    if (Math.abs(v) > 50) glide(v);
  };

  /** A press that became a drag doesn't also click what it started on. */
  const onClickCapture = (e: ReactMouseEvent<HTMLElement>) => {
    if (!suppress.current) return;
    suppress.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      stop();
      const left = el.getBoundingClientRect().left;
      opts.current.zoom(Math.exp(-e.deltaY * 0.01), e.clientX - left);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scroller, stop]);
  useEffect(() => stop, [stop]);

  return {
    dragging,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: end,
      onPointerCancel: end,
      onClickCapture,
    },
  };
}
