"use client";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import { AVATAR_MAX_BYTES, AVATAR_SIZE } from "@lume/core/shared";
import { Button } from "@/components/ui/Button";
import { Scrim } from "@/components/ui/Scrim";
import {
  ZOOM_MAX,
  ZOOM_MIN,
  bounds,
  clampOffset,
  coverScale,
  dragAxis,
  drawCrop,
  magnet,
  project,
  turned,
  type Offset,
  type Turn,
} from "@/lib/avatar/crop";
import s from "./profile.module.css";

const FRAME = 280;
const PREVIEWS = [72, 40, 24];

/** The 256 px square as WebP (JPEG where the browser can't make WebP), small enough to keep, in base64. */
async function encode(img: HTMLImageElement, turn: Turn, zoom: number, o: Offset): Promise<string | null> {
  const c = document.createElement("canvas");
  c.width = c.height = AVATAR_SIZE;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  drawCrop(ctx, img, turn, FRAME, zoom, o, AVATAR_SIZE);
  for (const q of [0.88, 0.8, 0.7, 0.6]) {
    let blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/webp", q));
    if (!blob || blob.type !== "image/webp")
      blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", q));
    if (!blob) return null;
    if (blob.size > AVATAR_MAX_BYTES) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  return null;
}

/**
 * Line up a photo (7C, canvas Profile): drag it inside a circle with a thirds grid, soft at the edges and settling in
 * the middle when close; zoom with the slider, the wheel or a pinch of the keys; turn it; and see it at the sizes
 * LUME shows it before saving. What's saved is exactly the previews.
 */
export function PhotoCropper({
  src,
  onCancel,
  onSave,
}: {
  src: string;
  onCancel: () => void;
  onSave: (base64: string) => Promise<string | null>;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [turn, setTurn] = useState<Turn>(0);
  const [zoom, setZoom] = useState(1);
  const [o, setO] = useState<Offset>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{
    x: number;
    y: number;
    o: Offset;
    trail: { x: number; y: number; t: number }[];
  } | null>(null);
  const previews = useRef<(HTMLCanvasElement | null)[]>([]);

  useEffect(() => {
    const i = new Image();
    i.onload = () => setImg(i);
    i.onerror = () => setFailed(true);
    i.src = src;
  }, [src]);

  const size = img ? turned({ w: img.naturalWidth, h: img.naturalHeight }, turn) : { w: 1, h: 1 };
  const b = bounds(size, FRAME, zoom);
  const k = coverScale(size, FRAME) * zoom;

  // The previews redraw from the same numbers the upload uses.
  useEffect(() => {
    if (!img) return;
    const raf = requestAnimationFrame(() =>
      previews.current.forEach((c, i) => {
        const px = PREVIEWS[i]! * 2;
        const ctx = c?.getContext("2d");
        if (ctx) drawCrop(ctx, img, turn, FRAME, zoom, clampOffset(o, b), px);
      }),
    );
    return () => cancelAnimationFrame(raf);
  });

  const setZoomKeep = (z: number) => {
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    setZoom(next);
    setO((cur) =>
      clampOffset({ x: (cur.x * next) / zoom, y: (cur.y * next) / zoom }, bounds(size, FRAME, next)),
    );
  };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, o, trail: [{ x: e.clientX, y: e.clientY, t: e.timeStamp }] };
    setDragging(true);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.trail = [...d.trail.slice(-4), { x: e.clientX, y: e.clientY, t: e.timeStamp }];
    setO({
      x: dragAxis(d.o.x + e.clientX - d.x, b.x, FRAME),
      y: dragAxis(d.o.y + e.clientY - d.y, b.y, FRAME),
    });
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d) return;
    const first = d.trail[0]!;
    const last = d.trail[d.trail.length - 1]!;
    const dt = Math.max(1, last.t - first.t);
    const vx = ((last.x - first.x) / dt) * 1000;
    const vy = ((last.y - first.y) / dt) * 1000;
    setO((cur) => {
      const thrown = clampOffset({ x: cur.x + project(vx), y: cur.y + project(vy) }, b);
      return { x: magnet(thrown.x), y: magnet(thrown.y) };
    });
  };
  const wheel = (e: WheelEvent<HTMLDivElement>) => setZoomKeep(zoom * Math.exp(-e.deltaY / 600));
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 32 : 8;
    const by: Record<string, Offset> = {
      ArrowLeft: { x: step, y: 0 },
      ArrowRight: { x: -step, y: 0 },
      ArrowUp: { x: 0, y: step },
      ArrowDown: { x: 0, y: -step },
    };
    if (by[e.key]) {
      e.preventDefault();
      setO((cur) => clampOffset({ x: cur.x - by[e.key]!.x, y: cur.y - by[e.key]!.y }, b));
    } else if (e.key === "+" || e.key === "=") setZoomKeep(zoom * 1.1);
    else if (e.key === "-") setZoomKeep(zoom / 1.1);
    else if (e.key === "Escape") onCancel();
  };

  const save = async () => {
    if (!img) return;
    setBusy(true);
    setError(null);
    const data = await encode(img, turn, zoom, clampOffset(o, b));
    const problem = data
      ? await onSave(data)
      : "LUME couldn’t make a small enough picture from this photo. Try another.";
    setBusy(false);
    if (problem) setError(problem);
  };

  const shown = dragging ? o : clampOffset(o, b);
  return (
    <Scrim onClose={busy ? undefined : onCancel}>
      <div className={s.cropper} role="dialog" aria-modal="true" aria-labelledby="crop-title">
        <h2 id="crop-title">Line up your photo</h2>
        <p className={s.cropLede}>Drag to move it, and zoom until your face sits in the circle.</p>
        {failed ? (
          <p role="alert" className={s.cropError}>
            LUME can’t read that file. Choose a JPEG, PNG or WebP photo.
          </p>
        ) : (
          <div className={s.cropBody}>
            <div
              className={s.frame}
              style={{ width: FRAME, height: FRAME }}
              data-dragging={dragging || undefined}
              tabIndex={0}
              role="application"
              aria-label="Photo position. Arrow keys move it; plus and minus zoom."
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
              onWheel={wheel}
              onKeyDown={key}
            >
              {img && (
                <img
                  className={s.photo}
                  src={src}
                  alt=""
                  draggable={false}
                  style={{
                    width: img.naturalWidth * k,
                    height: img.naturalHeight * k,
                    transform: `translate(-50%, -50%) translate(${shown.x}px, ${shown.y}px) rotate(${turn}deg)`,
                  }}
                />
              )}
              <span className={s.mask} aria-hidden />
              <span className={s.grid} aria-hidden>
                <i />
                <i />
                <i />
                <i />
              </span>
            </div>
            <div className={s.side}>
              <div className={s.previews} aria-label="How it will look">
                {PREVIEWS.map((px, i) => (
                  <canvas
                    key={px}
                    ref={(c) => {
                      previews.current[i] = c;
                    }}
                    width={px * 2}
                    height={px * 2}
                    style={{ width: px, height: px }}
                    aria-hidden
                  />
                ))}
              </div>
              <label className={s.zoom}>
                <span>Zoom</span>
                <input
                  type="range"
                  min={ZOOM_MIN}
                  max={ZOOM_MAX}
                  step={0.01}
                  value={zoom}
                  onChange={(e) => setZoomKeep(Number(e.target.value))}
                />
              </label>
              <Button onClick={() => setTurn((t) => ((t + 90) % 360) as Turn)}>Turn</Button>
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className={s.cropError}>
            {error}
          </p>
        )}
        <div className={s.cropActions}>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!img}>
            Save photo
          </Button>
        </div>
      </div>
    </Scrim>
  );
}
