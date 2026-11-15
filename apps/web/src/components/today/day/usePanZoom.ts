"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { rubberband } from "@/lib/today/timeline-math";

/** Movement before a press becomes a drag (a smaller wobble is still a click). */
export const DRAG_PX = 6;
/** Velocity is read over the last this many ms before letting go: a hold before letting go means no flick. */
const SAMPLE_MS = 100;
/** Per-ms decay of a flick's speed: scroll-like deceleration (Apple's 0.998). */
const DECAY = 0.998;
/** Below this speed (px/s) a flick has stopped. */
const STOP_V = 10;
/** One Ctrl + wheel event zooms by at most this much wheel (a mouse notch is 100): about a 1.28× step. */
const WHEEL_ZOOM_MAX = 25;

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
 * timeline 1:1, carries the flick's speed when let go and slows to a stop, and resists softly past either end.
 * Touch keeps the browser's own scrolling; two fingers pinch to zoom. Ctrl + scroll (and a trackpad pinch, Safari's
 * included) zooms; a plain mouse wheel moves the day sideways when there's nothing to scroll up and down.
 */
export function usePanZoom(
  scroller: RefObject<HTMLElement | null>,
  canvas: RefObject<HTMLElement | null>,
  o: {
    /** The furthest it can scroll sideways, in px. */
    maxLeft: () => number;
    /** Zoom by `factor` keeping the time under `anchorX` (px from the scroller's left edge) in place. */
    zoom: (factor: number, anchorX: number) => void;
    /** A press just became a drag. */
    onDragStart?: () => void;
  },
) {
  const drag = useRef<Drag | null>(null);
  const suppress = useRef(false);
  const frame = useRef<number | null>(null);
  /** A plain wheel easing the day sideways: where it is headed (notches add up), and its frame. */
  const wheel = useRef<{ target: number | null; frame: number }>({ target: null, frame: 0 });
  const [dragging, setDragging] = useState(false);
  const opts = useRef(o);
  opts.current = o;

  const shift = useCallback(
    (px: number) => {
      if (canvas.current) canvas.current.style.transform = px ? `translateX(${px}px)` : "";
    },
    [canvas],
  );
  /** Stop whatever is moving (a glide, a give settling back, a wheel easing) and put the day back in place. */
  const stop = useCallback(() => {
    if (frame.current != null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (wheel.current.frame) cancelAnimationFrame(wheel.current.frame);
    wheel.current = { target: null, frame: 0 };
    shift(0);
  }, [shift]);

  /** Ease a rubber-band offset back to rest. */
  const settle = useCallback(
    (from: number) => {
      const t0 = performance.now();
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / 300);
        shift(from * (1 - k) ** 3);
        frame.current = k < 1 ? requestAnimationFrame(step) : null;
      };
      frame.current = requestAnimationFrame(step);
    },
    [shift],
  );
  /** A flick meeting an end: ease out to the give, then settle back (no jump to it). */
  const bounce = useCallback(
    (to: number) => {
      const t0 = performance.now();
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / 120);
        shift(to * (1 - (1 - k) ** 2));
        frame.current = k < 1 ? requestAnimationFrame(step) : (settle(to), frame.current);
      };
      frame.current = requestAnimationFrame(step);
    },
    [shift, settle],
  );

  /** Carry a flick of `v` px/s (along the pointer) on until it slows to a stop; meeting an end, give a little. */
  const glide = useCallback(
    (v: number) => {
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
        speed *= DECAY ** dt;
        if (next < 0 || next > max) {
          el.scrollLeft = next < 0 ? 0 : max;
          // The rest of the flick shows as a short give at the end, then settles back.
          const over = next < 0 ? -next + Math.abs(speed) * 0.05 : next - max + Math.abs(speed) * 0.05;
          const w = el.clientWidth || 1;
          return bounce(next < 0 ? rubberband(over, w) : -rubberband(over, w));
        }
        el.scrollLeft = next;
        frame.current = Math.abs(speed) > STOP_V ? requestAnimationFrame(step) : null;
      };
      frame.current = requestAnimationFrame(step);
    },
    [scroller, bounce],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === "touch" || e.button !== 0) return;
    const el = scroller.current;
    if (!el) return;
    // Any press stops a glide; one on the scroller's own scrollbars is then the browser's, not a drag.
    stop();
    const box = el.getBoundingClientRect();
    if (e.clientX - box.left >= el.clientWidth || e.clientY - box.top >= el.clientHeight) return;
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
    const g = drag.current;
    const el = scroller.current;
    if (!g || !el || e.pointerType === "touch") return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!g.moved) {
      if (Math.hypot(dx, dy) < DRAG_PX) return;
      g.moved = true;
      setDragging(true);
      opts.current.onDragStart?.();
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
    if (e.pointerType === "touch") return;
    const g = drag.current;
    drag.current = null;
    if (!g?.moved) return;
    setDragging(false);
    suppress.current = true;
    setTimeout(() => (suppress.current = false), 400);
    const offset = canvas.current?.style.transform ? parseFloat(canvas.current.style.transform.slice(11)) : 0;
    if (offset) return settle(offset);
    // Only the movement in the last SAMPLE_MS before letting go counts: a hold first means no flick.
    const now = performance.now();
    const recent = [...g.samples.filter((s) => now - s.t <= SAMPLE_MS), { t: now, x: e.clientX }];
    const first = recent[0]!;
    const last = recent.at(-1)!;
    const v = recent.length > 1 && last.t > first.t ? ((last.x - first.x) / (last.t - first.t)) * 1000 : 0;
    if (Math.abs(v) > 50) glide(v);
  };

  /** A press that became a drag doesn't also click what it started on. */
  const onClickCapture = (e: ReactMouseEvent<HTMLElement>) => {
    if (!suppress.current) return;
    suppress.current = false;
    e.preventDefault();
    e.stopPropagation();
  };
  /** The browser's own drag of a link (or text) would cancel the pan: the timeline is dragged, not its links. */
  const onDragStart = (e: ReactDragEvent<HTMLElement>) => e.preventDefault();

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    /** Px from the scroller's left edge; the middle when the browser gives no position (Safari's gestures). */
    const anchorOf = (clientX: number | undefined) => {
      const x = (clientX ?? NaN) - el.getBoundingClientRect().left;
      return Number.isFinite(x) ? x : el.clientWidth / 2;
    };
    /** Ease scrollLeft towards the wheel's target, a quarter of the way each frame. */
    const ease = () => {
      const w = wheel.current;
      if (w.target == null) return;
      const gap = w.target - el.scrollLeft;
      if (Math.abs(gap) < 0.5) {
        el.scrollLeft = w.target;
        wheel.current = { target: null, frame: 0 };
        return;
      }
      el.scrollLeft += gap * 0.25;
      w.frame = requestAnimationFrame(ease);
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        stop();
        const d = Math.max(
          -WHEEL_ZOOM_MAX,
          Math.min(WHEEL_ZOOM_MAX, e.deltaY * (e.deltaMode === 1 ? 33 : 1)),
        );
        opts.current.zoom(Math.exp(-d * 0.01), anchorOf(e.clientX));
        return;
      }
      // A plain mouse wheel only scrolls up and down: with nothing to scroll that way (1 px of rounding allowed),
      // it moves the day sideways, easing like the browser's own scrolling, and notches add up.
      if (e.deltaY && !e.deltaX && !e.shiftKey && el.scrollHeight - el.clientHeight <= 1) {
        e.preventDefault();
        const w = wheel.current;
        const max = opts.current.maxLeft();
        const from = w.target ?? el.scrollLeft;
        w.target = Math.max(0, Math.min(max, from + e.deltaY * (e.deltaMode === 1 ? 33 : 1)));
        if (!w.frame) w.frame = requestAnimationFrame(ease);
      }
    };
    // Two fingers pinch to zoom. Touch events (not pointer events): the browser can't cancel them mid-pinch. The
    // move listener that can stop the browser's own panning is only there during a pinch, so one-finger scrolling
    // never waits for it.
    let pinch: { d: number } | null = null;
    const spread = (t: TouchList) =>
      Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY) || 1;
    const onTouchMove = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      if (e.cancelable) e.preventDefault();
      const d = spread(e.touches);
      opts.current.zoom(d / pinch.d, anchorOf((e.touches[0]!.clientX + e.touches[1]!.clientX) / 2));
      pinch = { d };
    };
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2 || pinch) return;
      pinch = { d: spread(e.touches) };
      el.addEventListener("touchmove", onTouchMove, { passive: false });
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length >= 2 || !pinch) return;
      pinch = null;
      el.removeEventListener("touchmove", onTouchMove);
    };
    // Safari's trackpad pinch arrives as gesture events. iOS sends them for a two-finger touch too, alongside the
    // touches already zooming: there they are ignored, so one pinch zooms once.
    let scale = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      scale = 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      if (pinch) return;
      const g = e as Event & { scale: number; clientX?: number };
      opts.current.zoom(g.scale / scale, anchorOf(g.clientX));
      scale = g.scale;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
    };
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
      onDragStart,
    },
  };
}
