"use client";
import { animate, motion, useMotionValue, useMotionValueEvent, useReducedMotion } from "motion/react";
import { Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { contentUrl, type LibraryFile } from "@/lib/files/client";
import { SPRINGS, toMotion } from "@/lib/motion";
import { Toolbar } from "./Toolbar";
import v from "./viewer.module.css";
import { capturePointer } from "@/lib/pointer";
import { isClick, isMouseWheel, project, softClamp } from "./zoom";

const MIN = 1;
const MAX = 6;
const STEP = 1.5;
/** Where a click zooms to, as Photos does. */
const CLICK_TO = 2.5;
/** One notch of a mouse's wheel. */
const NOTCH = 1.25;
/** A trackpad's pinch that has stopped this long has let go: past a limit, it settles back. */
const PINCH_IDLE_MS = 140;
/** Slower than this (px/s), a pan let go simply stops. */
const FLICK = 60;
const clampScale = (s: number) => Math.min(MAX, Math.max(MIN, s));

/**
 * A photo in LUME's viewer (canvas Detail), zoomed like Photos (owner, 2026-10-25): a click zooms in where it's clicked
 * and another fits it again; a mouse's wheel zooms a notch at a time, smoothly; a trackpad's or a finger's pinch follows
 * 1:1, giving softly past 1× and 6× and settling back; zoomed, a drag (or a trackpad's two fingers) pans, giving softly
 * at the photo's edges and carrying on when flicked. + − and 0 on the keyboard. `onZoomed` tells the viewer whether a
 * swipe should pan instead of changing file.
 */
export function ImageView({ file: f, onZoomed }: { file: LibraryFile; onZoomed(z: boolean): void }) {
  const reduce = !!useReducedMotion();
  const stage = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const scale = useMotionValue(1);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const [label, setLabel] = useState("Fit");
  const [loaded, setLoaded] = useState(false);
  // A photo the browser had already: its load can come before anyone listens.
  useEffect(() => {
    if (img.current?.complete && img.current.naturalWidth > 0) setLoaded(true);
  }, []);
  const zoomedRef = useRef(false);
  const report = useRef(onZoomed);
  report.current = onZoomed;
  /** Where a zoom is headed (a wheel's notches add up from here, not from a value still on its way). */
  const aim = useRef(1);
  /** A trackpad pinch on its way: its own scale, and the wait before it settles. */
  const pinching = useRef<{ raw: number; t: ReturnType<typeof setTimeout> | null }>({ raw: 1, t: null });

  useMotionValueEvent(scale, "change", (s) => {
    setLabel(s <= 1.001 ? "Fit" : `${Math.round(s * 100)}%`);
    const z = s > 1.001;
    if (z !== zoomedRef.current) {
      zoomedRef.current = z;
      report.current(z);
    }
  });

  const box = () => stage.current?.getBoundingClientRect();
  /** How far the photo may move at this scale before an edge would come away from the window's. */
  const bounds = (s: number) => {
    const el = img.current;
    const b = box();
    if (!el || !b) return { x: 0, y: 0 };
    return {
      x: Math.max(0, (el.offsetWidth * s - b.width) / 2),
      y: Math.max(0, (el.offsetHeight * s - b.height) / 2),
    };
  };
  const clampPan = (s: number, px: number, py: number) => {
    const b = bounds(s);
    return { x: Math.max(-b.x, Math.min(b.x, px)), y: Math.max(-b.y, Math.min(b.y, py)) };
  };
  /** Past an edge, the photo follows less and less (a soft edge, not a wall). */
  const softPan = (s: number, px: number, py: number) => {
    const b = bounds(s);
    const r = box();
    return {
      x: softClamp(px, -b.x, b.x, r?.width ?? 400),
      y: softClamp(py, -b.y, b.y, r?.height ?? 400),
    };
  };
  /** The pan that keeps the point under (cx, cy) where it is as the scale goes from `from` to `to`. */
  const around = (from: number, to: number, cx: number, cy: number) => {
    const b = box();
    const px = b ? cx - (b.left + b.width / 2) : 0;
    const py = b ? cy - (b.top + b.height / 2) : 0;
    const k = to / from;
    return { x: px - (px - x.get()) * k, y: py - (py - y.get()) * k };
  };
  const centre = () => {
    const b = box();
    return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : { x: 0, y: 0 };
  };
  const spring = () => toMotion(SPRINGS.default);

  /** Zoomed to `next` around a point, sprung (or at once: a pinch follows the fingers). */
  const go = (next: number, cx?: number, cy?: number, instant = false) => {
    // A pinch's settle still waiting would undo this zoom (pinch, then 0 at once): this zoom wins.
    if (pinching.current.t) {
      clearTimeout(pinching.current.t);
      pinching.current.t = null;
    }
    const s = clampScale(next);
    aim.current = s;
    const c = cx === undefined || cy === undefined ? centre() : { x: cx, y: cy };
    const a = around(scale.get(), s, c.x, c.y);
    const t = clampPan(s, a.x, a.y);
    if (instant || reduce) {
      scale.set(s);
      x.set(t.x);
      y.set(t.y);
      return;
    }
    void animate(scale, s, spring());
    void animate(x, t.x, spring());
    void animate(y, t.y, spring());
  };

  /** A pinch's own scale, soft past the limits; set at once, its pan keeping the point between the fingers. */
  const pinchTo = (raw: number, cx: number, cy: number) => {
    const s = softClamp(raw, MIN, MAX, 1);
    const t = around(scale.get(), s, cx, cy);
    const p = softPan(s, t.x, t.y);
    scale.set(s);
    x.set(p.x);
    y.set(p.y);
  };
  /** After a pinch: back inside the limits, and the photo back inside the window. */
  const settle = () => {
    const s = clampScale(scale.get());
    aim.current = s;
    const t = clampPan(s, x.get(), y.get());
    if (reduce) {
      scale.set(s);
      x.set(t.x);
      y.set(t.y);
      return;
    }
    if (s !== scale.get()) void animate(scale, s, spring());
    void animate(x, t.x, spring());
    void animate(y, t.y, spring());
  };

  // The wheel. A mouse's notches zoom, sprung; a trackpad's pinch (the browser sends it as Ctrl and the wheel) follows
  // 1:1; a trackpad's two-finger scroll pans once zoomed. A native listener, not passive, so the page never zooms.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const p = pinching.current;
        if (!p.t) p.raw = scale.get();
        else clearTimeout(p.t);
        p.raw = Math.min(MAX * 2, Math.max(MIN / 2, p.raw * Math.exp(-e.deltaY * 0.01)));
        pinchTo(p.raw, e.clientX, e.clientY);
        p.t = setTimeout(() => {
          p.t = null;
          settle();
        }, PINCH_IDLE_MS);
        return;
      }
      if (isMouseWheel(e)) {
        e.preventDefault();
        if (e.deltaY === 0) return;
        go(aim.current * (e.deltaY < 0 ? NOTCH : 1 / NOTCH), e.clientX, e.clientY);
        return;
      }
      if (scale.get() > 1.001) {
        e.preventDefault();
        const t = clampPan(scale.get(), x.get() - e.deltaX, y.get() - e.deltaY);
        x.set(t.x);
        y.set(t.y);
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", wheel);
      if (pinching.current.t) clearTimeout(pinching.current.t);
    };
    // go, pinchTo and settle read only refs and motion values.
  }, []);

  // + − 0, as in Photos. Not while typing, and never Ctrl or ⌘ with them (the browser's own zoom).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable) return;
      if (e.key === "+" || e.key === "=") go(aim.current * STEP);
      else if (e.key === "-" || e.key === "_") go(aim.current / STEP);
      else if (e.key === "0") go(1);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
    // go reads only refs and motion values.
  }, []);

  // Fingers and the mouse: a click zooms; two fingers pinch; one, once zoomed, pans and can be flicked.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const press = useRef<{ x: number; y: number; t: number; many: boolean } | null>(null);
  const pinch = useRef<{ d: number; s: number } | null>(null);
  const pan = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const trail = useRef<{ x: number; y: number; t: number }[]>([]);
  const dist = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const mid = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : { x: 0, y: 0 };
  };
  /** The pointer's speed over its last tenth of a second, in px/s. */
  const velocity = () => {
    const pts = trail.current;
    const last = pts.at(-1);
    const first = pts.find((p) => last && last.t - p.t <= 100);
    if (!last || !first || last.t === first.t) return { x: 0, y: 0 };
    const dt = (last.t - first.t) / 1000;
    return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
  };
  /** A pan let go: inside the edges it carries on as far as the flick would take it; past one, it springs back. */
  const release = () => {
    const s = scale.get();
    const vel = velocity();
    const fast = Math.hypot(vel.x, vel.y) > FLICK && !reduce;
    const end = clampPan(s, x.get() + (fast ? project(vel.x) : 0), y.get() + (fast ? project(vel.y) : 0));
    if (reduce) {
      x.set(end.x);
      y.set(end.y);
      return;
    }
    void animate(x, end.x, { ...spring(), velocity: fast ? vel.x : 0 });
    void animate(y, end.y, { ...spring(), velocity: fast ? vel.y : 0 });
  };

  return (
    <>
      <Toolbar>
        <div className={v.group} role="group" aria-label="Zoom">
          <button
            type="button"
            className={v.tb}
            aria-label="Zoom out"
            onClick={() => go(aim.current / STEP)}
            disabled={label === "Fit"}
          >
            <Minus size={16} aria-hidden />
          </button>
          <button
            type="button"
            className={v.zoomLabel}
            onClick={() => go(1)}
            aria-label={label === "Fit" ? "Fitted" : `${label}, fit to the window`}
          >
            {label}
          </button>
          <button
            type="button"
            className={v.tb}
            aria-label="Zoom in"
            onClick={() => go(aim.current * STEP)}
            disabled={label === `${MAX * 100}%`}
          >
            <Plus size={16} aria-hidden />
          </button>
        </div>
      </Toolbar>
      <div
        ref={stage}
        className={v.imageStage}
        data-zoomed={label !== "Fit" || undefined}
        onPointerDown={(e) => {
          if (e.pointerType === "mouse" && e.button !== 0) return;
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.current.size === 1)
            press.current = { x: e.clientX, y: e.clientY, t: e.timeStamp, many: false };
          else if (press.current) press.current.many = true;
          if (pointers.current.size === 2) {
            pinch.current = { d: dist(), s: scale.get() };
            pan.current = null;
          } else if (scale.get() > 1.001) {
            capturePointer(e.currentTarget, e.pointerId);
            x.stop();
            y.stop();
            pan.current = { x: e.clientX, y: e.clientY, px: x.get(), py: y.get() };
            trail.current = [{ x: e.clientX, y: e.clientY, t: e.timeStamp }];
          }
        }}
        onPointerMove={(e) => {
          if (!pointers.current.has(e.pointerId)) return;
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pinch.current && pointers.current.size === 2) {
            const m = mid();
            pinchTo(pinch.current.s * (dist() / (pinch.current.d || 1)), m.x, m.y);
          } else if (pan.current) {
            const t = softPan(
              scale.get(),
              pan.current.px + e.clientX - pan.current.x,
              pan.current.py + e.clientY - pan.current.y,
            );
            x.set(t.x);
            y.set(t.y);
            trail.current.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
            if (trail.current.length > 12) trail.current.shift();
          }
        }}
        onPointerUp={(e) => {
          if (!pointers.current.has(e.pointerId)) return;
          pointers.current.delete(e.pointerId);
          const p = press.current;
          const clicked =
            !!p &&
            !p.many &&
            pointers.current.size === 0 &&
            isClick(p, { x: e.clientX, y: e.clientY, t: e.timeStamp });
          if (pointers.current.size === 0) press.current = null;
          if (clicked) {
            pan.current = null;
            // In where it was clicked; zoomed, back to fit.
            go(scale.get() > 1.001 ? 1 : CLICK_TO, e.clientX, e.clientY);
            return;
          }
          if (pinch.current && pointers.current.size < 2) {
            pinch.current = null;
            settle();
            return;
          }
          if (pan.current && pointers.current.size === 0) {
            pan.current = null;
            release();
          }
        }}
        onPointerCancel={(e) => {
          pointers.current.delete(e.pointerId);
          press.current = null;
          pinch.current = null;
          pan.current = null;
          settle();
        }}
      >
        <motion.img
          ref={img}
          src={contentUrl(f.id)}
          alt={f.name}
          draggable={false}
          className={v.image}
          data-loaded={loaded || undefined}
          onLoad={() => setLoaded(true)}
          style={{ scale, x, y }}
        />
        {!loaded && f.thumbUrl && (
          <img src={f.thumbUrl} alt="" aria-hidden className={`${v.image} ${v.standIn}`} />
        )}
      </div>
    </>
  );
}
