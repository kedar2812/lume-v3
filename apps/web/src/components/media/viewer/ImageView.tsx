"use client";
import { animate, motion, useMotionValue, useMotionValueEvent, useReducedMotion } from "motion/react";
import { Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { contentUrl, type LibraryFile } from "@/lib/files/client";
import { SPRINGS, toMotion } from "@/lib/motion";
import { Toolbar } from "./Toolbar";
import v from "./viewer.module.css";

const MIN = 1;
const MAX = 6;
const STEP = 1.5;
const clampScale = (s: number) => Math.min(MAX, Math.max(MIN, s));

/**
 * A photo in LUME's viewer (canvas Detail): fitted to the window, zoomed from where the pointer is (a pinch, Ctrl and
 * the wheel, a double-click, or the buttons), and panned by dragging once zoomed. The photo never slides out of
 * view: a pan stops at its edges. `onZoomed` tells the viewer whether a swipe should pan instead of changing file.
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
  const zoomedRef = useRef(false);
  const report = useRef(onZoomed);
  report.current = onZoomed;

  useMotionValueEvent(scale, "change", (s) => {
    setLabel(s <= 1.001 ? "Fit" : `${Math.round(s * 100)}%`);
    const z = s > 1.001;
    if (z !== zoomedRef.current) {
      zoomedRef.current = z;
      report.current(z);
    }
  });

  /** How far the photo may move at this scale before an edge would come away from the window's. */
  const bounds = (s: number) => {
    const el = img.current;
    const box = stage.current?.getBoundingClientRect();
    if (!el || !box) return { x: 0, y: 0 };
    return {
      x: Math.max(0, (el.offsetWidth * s - box.width) / 2),
      y: Math.max(0, (el.offsetHeight * s - box.height) / 2),
    };
  };
  const clampPan = (s: number, px: number, py: number) => {
    const b = bounds(s);
    return { x: Math.max(-b.x, Math.min(b.x, px)), y: Math.max(-b.y, Math.min(b.y, py)) };
  };
  /** The point under (cx, cy) stays under it as the scale changes. */
  const target = (next: number, cx: number, cy: number) => {
    const box = stage.current?.getBoundingClientRect();
    const px = box ? cx - (box.left + box.width / 2) : 0;
    const py = box ? cy - (box.top + box.height / 2) : 0;
    const s = scale.get();
    const k = next / s;
    return clampPan(next, px - (px - x.get()) * k, py - (py - y.get()) * k);
  };
  const go = (next: number, cx?: number, cy?: number, instant = false) => {
    const s = clampScale(next);
    const box = stage.current?.getBoundingClientRect();
    const t = target(s, cx ?? (box ? box.left + box.width / 2 : 0), cy ?? (box ? box.top + box.height / 2 : 0));
    if (instant || reduce) {
      scale.set(s);
      x.set(t.x);
      y.set(t.y);
      return;
    }
    const spring = toMotion(SPRINGS.default);
    void animate(scale, s, spring);
    void animate(x, t.x, spring);
    void animate(y, t.y, spring);
  };

  // The wheel: Ctrl (and a trackpad's pinch, which the browser sends as Ctrl and the wheel) zooms; once zoomed, the
  // wheel pans. A native listener, not passive, so the page itself never zooms instead.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        go(scale.get() * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY, true);
      } else if (scale.get() > 1.001) {
        e.preventDefault();
        const t = clampPan(scale.get(), x.get() - e.deltaX, y.get() - e.deltaY);
        x.set(t.x);
        y.set(t.y);
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
    // go and clampPan read only refs and motion values.
  }, []);

  // A pinch with two fingers, a pan with one once zoomed.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; s: number } | null>(null);
  const pan = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const dist = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const mid = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : { x: 0, y: 0 };
  };

  return (
    <>
      <Toolbar>
        <div className={v.group} role="group" aria-label="Zoom">
          <button type="button" className={v.tb} aria-label="Zoom out" onClick={() => go(scale.get() / STEP)} disabled={label === "Fit"}>
            <Minus size={16} aria-hidden />
          </button>
          <button type="button" className={v.zoomLabel} onClick={() => go(1)} aria-label={label === "Fit" ? "Fitted" : `${label}, fit to the window`}>
            {label}
          </button>
          <button type="button" className={v.tb} aria-label="Zoom in" onClick={() => go(scale.get() * STEP)} disabled={label === `${MAX * 100}%`}>
            <Plus size={16} aria-hidden />
          </button>
        </div>
      </Toolbar>
      <div
        ref={stage}
        className={v.imageStage}
        data-zoomed={label !== "Fit" || undefined}
        onDoubleClick={(e) => go(scale.get() > 1.001 ? 1 : 2.5, e.clientX, e.clientY)}
        onPointerDown={(e) => {
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.current.size === 2) {
            pinch.current = { d: dist(), s: scale.get() };
            pan.current = null;
          } else if (scale.get() > 1.001) {
            e.currentTarget.setPointerCapture?.(e.pointerId);
            pan.current = { x: e.clientX, y: e.clientY, px: x.get(), py: y.get() };
          }
        }}
        onPointerMove={(e) => {
          if (!pointers.current.has(e.pointerId)) return;
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pinch.current && pointers.current.size === 2) {
            const m = mid();
            go(pinch.current.s * (dist() / (pinch.current.d || 1)), m.x, m.y, true);
          } else if (pan.current) {
            const t = clampPan(scale.get(), pan.current.px + e.clientX - pan.current.x, pan.current.py + e.clientY - pan.current.y);
            x.set(t.x);
            y.set(t.y);
          }
        }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId);
          if (pointers.current.size < 2) pinch.current = null;
          pan.current = null;
          // A pinch let go below fit settles back to it.
          if (scale.get() < 1) go(1);
        }}
        onPointerCancel={(e) => {
          pointers.current.delete(e.pointerId);
          pinch.current = null;
          pan.current = null;
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
        {!loaded && f.thumbUrl && <img src={f.thumbUrl} alt="" aria-hidden className={`${v.image} ${v.standIn}`} />}
      </div>
    </>
  );
}
