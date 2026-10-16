"use client";
import { useEffect, useRef, useState } from "react";

type Shot = { n: number; width: number; height: number };

/**
 * A screenshot full size over the whole window (spec 2026-10-16 §3.3): previous and next, fit or 100%, Download, and
 * Esc to close. Focus moves in, and goes back to the thumbnail that opened it.
 */
export function ShotViewer({
  id,
  shots,
  start,
  label,
  onClose,
}: {
  id: string;
  shots: Shot[];
  start: number;
  label: string;
  onClose: () => void;
}) {
  const [i, setI] = useState(start);
  const [actual, setActual] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") close.current();
      else if (e.key === "ArrowRight") setI((v) => Math.min(shots.length - 1, v + 1));
      else if (e.key === "ArrowLeft") setI((v) => Math.max(0, v - 1));
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      back?.focus();
    };
  }, [shots.length]);
  const shot = shots[i]!;
  const src = `/api/feedback/${id}/images/${shot.n}`;
  return (
    <div
      className="viewer"
      role="dialog"
      aria-modal="true"
      aria-label={`Screenshot ${i + 1} of ${shots.length}`}
      ref={panel}
      tabIndex={-1}
    >
      <header className="viewer-bar">
        <b>
          Screenshot {i + 1} of {shots.length}
        </b>
        <span className="viewer-sub">
          {label} · {shot.width.toLocaleString("en-IN")} × {shot.height.toLocaleString("en-IN")}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="vb" aria-pressed={!actual} onClick={() => setActual(false)}>
          Fit
        </button>
        <button type="button" className="vb" aria-pressed={actual} onClick={() => setActual(true)}>
          100%
        </button>
        <a className="vb" href={`${src}?download=1`} download>
          Download
        </a>
        <button type="button" className="vb" onClick={onClose} aria-label="Close (Esc)">
          Esc
        </button>
      </header>
      <div className={actual ? "viewer-stage actual" : "viewer-stage"}>
        <img src={src} alt={`Screenshot ${i + 1} from ${label}`} width={shot.width} height={shot.height} />
      </div>
      <button
        type="button"
        className="viewer-arrow left"
        aria-label="Previous screenshot"
        disabled={i === 0}
        onClick={() => setI(i - 1)}
      >
        ‹
      </button>
      <button
        type="button"
        className="viewer-arrow right"
        aria-label="Next screenshot"
        disabled={i === shots.length - 1}
        onClick={() => setI(i + 1)}
      >
        ›
      </button>
    </div>
  );
}
