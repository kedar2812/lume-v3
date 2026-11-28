"use client";
import { useReactFlow } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  clampZ,
  decay,
  DRAG_SLOP,
  fitCam,
  readableCam,
  GLIDE_STOP,
  releaseSpeed,
  soft,
  springStep,
  wheelKind,
  zoomAbout,
  Z_MAX,
  Z_MIN,
  type Box,
  type Cam,
} from "./camera";

/** The smallest a flow opens at: its steps still read (owner 2026-11-28). Fit still shows all of it. */
const OPEN_MIN_Z = 0.75;

/** Anything on the canvas that's not the canvas itself: a press there is that thing's, never a pan. */
const BUSY =
  ".react-flow__node, .react-flow__handle, .react-flow__edge, .react-flow__minimap, button, a, input, textarea, select, [data-tool]";
/** What sits over the canvas rather than on it: a press there never stops the camera. */
const TOOLS = "[data-tool], .react-flow__minimap";

type Goal =
  | { kind: "zoom"; z: number; ax: number; ay: number; wx: number; wy: number }
  | { kind: "move"; x: number; y: number; z: number };

/**
 * The approved canvas's camera on React Flow's viewport (React Flow's own pan and zoom are off): drag 1:1 with
 * momentum, pinch and Ctrl/⌘-scroll about the cursor with a soft edge, wheel notches, buttons, Fit and keys on a
 * critically damped spring; Reduce Motion goes straight there. Every motion starts from where the canvas is now.
 */
export function useCamera(o: { reduce: boolean; initial?: Cam }) {
  const rf = useReactFlow();
  const cam = useRef<Cam>(o.initial ?? { x: 0, y: 0, z: 1 });
  const [zoom, setZoom] = useState(cam.current.z);
  const [grabbing, setGrabbing] = useState(false);
  const host = useRef<HTMLDivElement | null>(null);
  const goal = useRef<Goal | null>(null);
  const vel = useRef({ x: 0, y: 0, z: 0 });
  const glide = useRef<{ vx: number; vy: number } | null>(null);
  const drag = useRef<{
    id: number;
    sx: number;
    sy: number;
    x0: number;
    y0: number;
    moved: boolean;
    hist: [number, number, number][];
  } | null>(null);
  const pinchEnd = useRef(0);
  const gesture = useRef<{ kind: "pinch" | "wheel" | "pan"; t: number }>({ kind: "pan", t: 0 });
  const raf = useRef(0);
  const last = useRef(0);
  const reduce = useRef(o.reduce);
  reduce.current = o.reduce;

  const apply = useCallback(() => {
    const c = cam.current;
    void rf.setViewport({ x: c.x, y: c.y, zoom: c.z });
    setZoom((z) => (Math.abs(z - c.z) > 0.004 ? c.z : z));
  }, [rf]);

  const size = () => {
    const r = host.current?.getBoundingClientRect();
    return { w: r?.width ?? 0, h: r?.height ?? 0, left: r?.left ?? 0, top: r?.top ?? 0 };
  };

  const tick = useCallback(
    (t: number) => {
      const dt = Math.min(0.032, last.current ? (t - last.current) / 1000 : 0.016);
      last.current = t;
      const c = cam.current;
      let moving = false;
      const g = goal.current;
      if (g?.kind === "zoom") {
        const s = springStep(c.z, vel.current.z, g.z, dt);
        vel.current.z = s.v;
        cam.current = { x: g.ax - g.wx * s.value, y: g.ay - g.wy * s.value, z: s.value };
        if (Math.abs(s.value - g.z) < 0.0004 && Math.abs(s.v) < 0.002) {
          cam.current = { x: g.ax - g.wx * g.z, y: g.ay - g.wy * g.z, z: g.z };
          goal.current = null;
        }
      } else if (g?.kind === "move") {
        const sx = springStep(c.x, vel.current.x, g.x, dt);
        const sy = springStep(c.y, vel.current.y, g.y, dt);
        const sz = springStep(c.z, vel.current.z, g.z, dt);
        vel.current = { x: sx.v, y: sy.v, z: sz.v };
        cam.current = { x: sx.value, y: sy.value, z: sz.value };
        if (
          Math.abs(sx.value - g.x) < 0.3 &&
          Math.abs(sy.value - g.y) < 0.3 &&
          Math.abs(sz.value - g.z) < 0.0004
        ) {
          cam.current = { x: g.x, y: g.y, z: g.z };
          goal.current = null;
          vel.current = { x: 0, y: 0, z: 0 };
        }
      } else if (glide.current) {
        const gl = glide.current;
        cam.current = { ...c, x: c.x + gl.vx * dt, y: c.y + gl.vy * dt };
        gl.vx = decay(gl.vx, dt * 1000);
        gl.vy = decay(gl.vy, dt * 1000);
        if (Math.hypot(gl.vx, gl.vy) < GLIDE_STOP) glide.current = null;
      }
      moving = !!goal.current || !!glide.current;
      // A pinch ended: past the limits it eases back to them, about the middle of the view. Either way the wait is
      // over, so the frames stop once nothing moves (review 2026-11-24: they ran on after every pinch).
      if (!goal.current && pinchEnd.current && t > pinchEnd.current) {
        pinchEnd.current = 0;
        if (cam.current.z > Z_MAX || cam.current.z < Z_MIN) {
          const { w, h } = size();
          zoomTo(clampZ(cam.current.z), w / 2, h / 2);
          moving = true;
        }
      }
      apply();
      raf.current = moving || drag.current || pinchEnd.current ? requestAnimationFrame(tick) : 0;
      if (!raf.current) last.current = 0;
    },
    [apply],
  );
  const run = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(tick);
  }, [tick]);
  const stop = () => {
    goal.current = null;
    glide.current = null;
    vel.current = { x: 0, y: 0, z: 0 };
  };

  /** A spring to `z`, keeping the canvas point under (px, py) where it is on screen. */
  const zoomTo = useCallback(
    (z: number, px: number, py: number) => {
      const zz = clampZ(z);
      const c = cam.current;
      if (reduce.current) {
        cam.current = zoomAbout(c, zz, px, py);
        goal.current = null;
        apply();
        return;
      }
      glide.current = null;
      goal.current = { kind: "zoom", z: zz, ax: px, ay: py, wx: (px - c.x) / c.z, wy: (py - c.y) / c.z };
      run();
    },
    [apply, run],
  );
  const moveTo = useCallback(
    (to: Cam) => {
      if (reduce.current) {
        cam.current = to;
        goal.current = null;
        apply();
        return;
      }
      glide.current = null;
      vel.current = { x: 0, y: 0, z: 0 };
      goal.current = { kind: "move", ...to };
      run();
    },
    [apply, run],
  );

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const local = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top] as const;
    };
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest(".react-flow__minimap, [data-tool]")) return;
      e.preventDefault();
      const [px, py] = local(e);
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      const now = performance.now();
      let kind = wheelKind(e);
      // Mid-gesture a trackpad can send what looks like a wheel's notch: the gesture it's in decides.
      if (kind === "wheel" && gesture.current.kind === "pan" && now - gesture.current.t < 150) kind = "pan";
      gesture.current = { kind, t: now };
      const c = cam.current;
      if (kind === "pinch") {
        stop();
        cam.current = zoomAbout(c, soft(c.z * Math.exp(-e.deltaY * k * 0.0085)), px, py);
        pinchEnd.current = performance.now() + 140;
        apply();
        run();
      } else if (kind === "wheel") {
        const g = goal.current;
        const from = g?.kind === "zoom" ? g.z : c.z;
        zoomTo(from * Math.exp(-e.deltaY * k * 0.0022), px, py);
      } else {
        stop();
        cam.current = { ...c, x: c.x - e.deltaX * k, y: c.y - e.deltaY * k };
        apply();
        run();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const hit = e.target as HTMLElement;
      // A press on the canvas (a step, a line, the dots) holds the camera where it is: a step pressed while the view
      // glides stays under the pointer, so the press is that step's (gate 53: the opening glide carried it away and
      // the click was lost). The tools and the map leave it going: + and − pressed fast add up, and LUME AI's fit
      // ends where it was meant to (review 2026-11-27).
      if (!hit.closest(TOOLS)) stop();
      if (hit.closest(BUSY)) return;
      const c = cam.current;
      drag.current = {
        id: e.pointerId,
        sx: e.clientX,
        sy: e.clientY,
        x0: c.x,
        y0: c.y,
        moved: false,
        hist: [[performance.now(), e.clientX, e.clientY]],
      };
      run();
    };
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.id) return;
      // Let go outside the canvas before it became a drag (no capture yet): it's over, never a drag with no button.
      if (!d.moved && e.buttons === 0) {
        drag.current = null;
        return;
      }
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
      if (!d.moved) {
        // A drag now, not a click: the pointer is the canvas's until it's let go (a click still reaches React Flow).
        el.setPointerCapture(e.pointerId);
        setGrabbing(true);
      }
      d.moved = true;
      cam.current = { ...cam.current, x: d.x0 + dx, y: d.y0 + dy };
      const now = performance.now();
      d.hist.push([now, e.clientX, e.clientY]);
      while (d.hist.length > 2 && now - d.hist[0]![0] > 90) d.hist.shift();
    };
    const onUp = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.id) return;
      drag.current = null;
      setGrabbing(false);
      if (d.moved && !reduce.current) glide.current = releaseSpeed(d.hist, performance.now());
      run();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    apply();
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [apply, run, zoomTo]);

  const center = () => {
    const { w, h } = size();
    return [w / 2, h / 2] as const;
  };
  const target = () => {
    const g = goal.current;
    return g?.kind === "zoom" ? g.z : cam.current.z;
  };
  return {
    hostRef: host,
    zoom,
    grabbing,
    zoomIn: () => zoomTo(target() * 1.25, ...center()),
    zoomOut: () => zoomTo(target() / 1.25, ...center()),
    zoomReset: () => zoomTo(1, ...center()),
    zoomAt: (z: number, px: number, py: number) => zoomTo(z, px, py),
    /** The whole flow in view, clear of the tools (and of the panel when it's open). */
    fit: (box: Box, panelOpen: boolean, room?: { left: number }) => {
      const { w, h } = size();
      if (!w || !h) return;
      moveTo(fitCam(box, w, h, { left: room?.left ?? 64, right: panelOpen ? 368 : 24, top: 24, bottom: 96 }));
    },
    /** As a flow opens: the whole of it when that reads, else readable from its start (readableCam). */
    open: (box: Box, start?: { x: number; y: number }) => {
      const { w, h } = size();
      if (!w || !h) return;
      moveTo(readableCam(box, w, h, { left: 64, right: 24, top: 24, bottom: 96 }, OPEN_MIN_Z, start));
    },
    /** Show this canvas point in the middle, at the zoom it's at. */
    centerOn: (x: number, y: number) => {
      const { w, h } = size();
      const z = cam.current.z;
      moveTo({ x: w / 2 - x * z, y: h / 2 - y * z, z });
    },
    nudge: (dx: number, dy: number) =>
      moveTo({ ...cam.current, x: cam.current.x + dx, y: cam.current.y + dy }),
    get cam() {
      return cam.current;
    },
  };
}
