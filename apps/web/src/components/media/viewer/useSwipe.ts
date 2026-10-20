"use client";
import { animate, useMotionValue, type MotionValue } from "motion/react";
import { useRef, type PointerEvent } from "react";
import { SPRINGS, project, releaseVelocity, rubberband, toMotion } from "@/lib/motion";

export type SwipeDirection = "next" | "previous";

/**
 * Where a swipe between files ends (apple-design §6): where the gesture is headed (its release point plus the throw
 * of its velocity), not where the finger let go. It goes when that's past half the width in the way it was dragged;
 * a flick back the other way, or no file that way, springs it back.
 */
export function swipeOutcome(o: {
  dx: number;
  velocity: number;
  width: number;
  canGo(d: SwipeDirection): boolean;
}): SwipeDirection | "stay" {
  const end = o.dx + project(o.velocity);
  if (o.dx === 0 || Math.sign(end) !== Math.sign(o.dx) || Math.abs(end) < o.width / 2) return "stay";
  const d: SwipeDirection = o.dx < 0 ? "next" : "previous";
  return o.canGo(d) ? d : "stay";
}

/** How far a finger moves before it's a swipe and not a tap (apple-design §10). */
const SLOP = 10;

/**
 * Swiping between files: the stage follows the finger 1:1 from where it was grabbed, resists past the first and last
 * file, and on release goes on with the finger's own velocity or springs back. A vertical move, a second finger or
 * `enabled` false (a zoomed photo pans instead) leaves it alone.
 */
export function useSwipe(o: {
  enabled: boolean;
  canGo(d: SwipeDirection): boolean;
  onSwipe(d: SwipeDirection): void;
}): {
  x: MotionValue<number>;
  bind: {
    onPointerDown(e: PointerEvent<HTMLElement>): void;
    onPointerMove(e: PointerEvent<HTMLElement>): void;
    onPointerUp(e: PointerEvent<HTMLElement>): void;
    onPointerCancel(e: PointerEvent<HTMLElement>): void;
  };
} {
  const x = useMotionValue(0);
  const g = useRef<{
    id: number;
    x0: number;
    y0: number;
    locked: boolean;
    width: number;
    samples: [number, number][];
  } | null>(null);
  const pointers = useRef(new Set<number>());
  const opts = useRef(o);
  opts.current = o;

  const settle = (to: number, velocity: number, then?: () => void) =>
    animate(x, to, { ...toMotion(SPRINGS.default), velocity }).then(() => then?.());

  const end = (e: PointerEvent<HTMLElement>, cancelled: boolean) => {
    pointers.current.delete(e.pointerId);
    const s = g.current;
    if (!s || s.id !== e.pointerId) return;
    g.current = null;
    if (!s.locked) return;
    const velocity = releaseVelocity(s.samples.slice(-5));
    const out = cancelled
      ? "stay"
      : swipeOutcome({ dx: e.clientX - s.x0, velocity, width: s.width, canGo: opts.current.canGo });
    if (out === "stay") return void settle(0, velocity);
    const to = out === "next" ? -s.width : s.width;
    void settle(to, velocity, () => {
      opts.current.onSwipe(out);
      x.jump(0);
    });
  };

  return {
    x,
    bind: {
      onPointerDown(e) {
        pointers.current.add(e.pointerId);
        if (!opts.current.enabled || pointers.current.size > 1 || (e.pointerType === "mouse" && e.button !== 0)) {
          // A second finger is a pinch: whatever the first one started goes back.
          if (g.current?.locked) void settle(0, 0);
          g.current = null;
          return;
        }
        g.current = {
          id: e.pointerId,
          x0: e.clientX,
          y0: e.clientY,
          locked: false,
          width: e.currentTarget.getBoundingClientRect().width || window.innerWidth,
          samples: [[e.timeStamp, e.clientX]],
        };
      },
      onPointerMove(e) {
        const s = g.current;
        if (!s || s.id !== e.pointerId) return;
        let dx = e.clientX - s.x0;
        const dy = e.clientY - s.y0;
        if (!s.locked) {
          if (Math.abs(dy) > SLOP && Math.abs(dy) > Math.abs(dx)) return void (g.current = null);
          if (Math.abs(dx) <= SLOP) return;
          s.locked = true;
          // Picked up from here: no jump by the slop the finger travelled before it counted.
          s.x0 += Math.sign(dx) * SLOP;
          dx = e.clientX - s.x0;
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }
        s.samples.push([e.timeStamp, e.clientX]);
        if (s.samples.length > 8) s.samples.shift();
        const d: SwipeDirection = dx < 0 ? "next" : "previous";
        x.set(opts.current.canGo(d) ? dx : rubberband(dx, s.width));
      },
      onPointerUp: (e) => end(e, false),
      onPointerCancel: (e) => end(e, true),
    },
  };
}
