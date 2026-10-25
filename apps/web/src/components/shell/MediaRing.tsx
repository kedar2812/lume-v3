"use client";
import type { Batch } from "@/lib/media/uploads";
import s from "./shell.module.css";

const R = 7;
const C = 2 * Math.PI * R;

/** "Uploading 12 of 40 · 34%": the whole batch, as the tray says it. */
export const batchWords = (b: Batch) =>
  b.done
    ? `${b.total} ${b.total === 1 ? "file" : "files"} added`
    : `Uploading ${b.added} of ${b.total} · ${Math.round(b.share * 100)}%`;

/**
 * Media's item while files go up (owner, 2026-10-25): a small ring filling with the whole batch, its words on hover;
 * once everything is in, the ring turns into a green tick (and the item blinks three times, in CSS).
 */
export function MediaRing({ batch }: { batch: Batch }) {
  return (
    <span className={s.upRing} data-done={batch.done || undefined} aria-hidden>
      <svg viewBox="0 0 20 20">
        <circle className={s.upTrack} cx="10" cy="10" r={R} />
        <circle
          className={s.upFill}
          cx="10"
          cy="10"
          r={R}
          strokeDasharray={C}
          strokeDashoffset={C * (1 - (batch.done ? 1 : batch.share))}
          transform="rotate(-90 10 10)"
        />
        {batch.done && <path className={s.upTick} d="m6.6 10.3 2.3 2.3 4.5-5" />}
      </svg>
      <span className={s.upTip}>{batchWords(batch)}</span>
    </span>
  );
}
