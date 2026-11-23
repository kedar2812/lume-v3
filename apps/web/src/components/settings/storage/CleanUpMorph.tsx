"use client";
import { useReducedMotion } from "motion/react";
import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { storageCount, storageSize, type CleanKind } from "@lume/core/shared";
import { Button } from "@/components/ui/Button";
import { RefreshMorph, Tick } from "@/components/ui/RefreshMorph";
import r from "@/components/ui/refresh.module.css";
import { usePhasedRefresh } from "@/components/ui/usePhasedRefresh";
import { storageClient, type Cleanup } from "@/lib/settings/storage";
import s from "./storage.module.css";

const TILES = 7;
const POLL_MS = 700;
const wait = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
/** No progress for this long: the page stops watching (the clean-up carries on). */
export const QUIET_POLL_MS = 10 * 60_000;

export type CleanUpHandle = { clear(kinds: CleanKind[]): void };

/**
 * Clean up's button and its motion (approved canvas): Refresh's morph, with its own card. The button lifts into the
 * glass pill ("Giving back 20.7 GB"), opens into a card where files lift off the shelf one by one and come apart
 * while the disk drains and the count rises, then the tick ("20.7 GB back"), then back into the button with
 * "✓ 20.7 GB back". The page reads its numbers again as it lands. Reduce Motion: the still card.
 */
export const CleanUpMorph = forwardRef<
  CleanUpHandle,
  { usedShare: number; diskTotal: number | null; onOpen(): void; onLanded(): void; running: Cleanup | null }
>(function CleanUpMorph({ usedShare, diskTotal, onOpen, onLanded, running }, ref) {
  const reduce = !!useReducedMotion();
  const [job, setJob] = useState<Cleanup | null>(running);
  const kinds = useRef<CleanKind[]>([]);
  const run = useCallback(async () => {
    const started = await storageClient.clean(kinds.current);
    // Already running (another admin, another tab): watch that one instead.
    let c: Cleanup | null = started.ok
      ? started.data
      : started.status === 409 && started.details
        ? (started.details as Cleanup)
        : null;
    if (!c) throw new Error(started.ok ? "" : started.message);
    setJob(c);
    // Watched while it moves; one with no progress for QUIET_POLL_MS is left to finish on its own (LUME looks after
    // it), so the page never waits forever.
    let moved = Date.now();
    while (c.status === "running") {
      if (Date.now() - moved > QUIET_POLL_MS)
        throw new Error("LUME is still clearing in the background. Look again in a while.");
      await wait(POLL_MS);
      const p = await storageClient.progress(c.id);
      if (p.ok) {
        if (p.data.filesDone !== c.filesDone || p.data.status !== c.status) moved = Date.now();
        c = p.data;
        setJob(c);
      }
    }
    if (c.status === "failed")
      throw new Error(c.problem ?? "LUME couldn't finish clearing. What it cleared is gone; try again.");
    onLanded();
    return c;
  }, [onLanded]);
  const announce = useCallback((c: Cleanup) => `${storageSize(c.bytesDone)} back on this server.`, []);
  const phased = usePhasedRefresh({ reduce, run, announce });
  useImperativeHandle(ref, () => ({
    clear: (k) => {
      kinds.current = k;
      void phased.press();
    },
  }));

  const btn = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState({ w: 120, h: 34 });
  useLayoutEffect(() => {
    if (btn.current) setBox({ w: btn.current.offsetWidth, h: btn.current.offsetHeight });
  }, [phased.phase]);

  const planned = job?.bytesPlanned ?? 0;
  const done = job?.bytesDone ?? 0;
  const share = planned ? Math.min(1, done / planned) : 0;
  const total = diskTotal ?? 0;
  const nowShare = total ? Math.max(0, usedShare - done / total) : usedShare;
  const warn = !!phased.failure;
  const back = storageSize(phased.result?.bytesDone ?? done);
  return (
    <span className={r.anchor}>
      <Button
        ref={btn}
        variant="primary"
        aria-disabled={phased.phase !== "idle" || undefined}
        className={r.button}
        data-phase={phased.phase}
        onClick={() => phased.phase === "idle" && onOpen()}
      >
        {phased.phase === "landed" ? (
          <span className={r.landed} data-warn={warn || undefined}>
            {!warn && <Tick size={13} />}
            {warn ? "Try again" : `${back} back`}
          </span>
        ) : (
          <>
            <svg
              viewBox="0 0 16 16"
              width="15"
              height="15"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 8.5h6.6l.7-8.5" />
            </svg>
            Clean up
          </>
        )}
      </Button>
      <RefreshMorph
        phase={phased.phase}
        box={box}
        reduce={reduce}
        warn={warn}
        pill={
          <>
            <svg className={r.spin} viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path
                d="M13.5 8A5.5 5.5 0 1 1 11.9 4.1M13.5 2.5v3h-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
            Giving back {storageSize(planned)}
          </>
        }
        card={
          <>
            <div className={s.shelf} aria-hidden>
              {Array.from({ length: TILES }, (_, i) => (
                <i key={i} className={s.tile} data-gone={share > (i + 0.5) / TILES || undefined} />
              ))}
            </div>
            <div className={s.drain} aria-hidden>
              <i style={{ width: `${Math.max(4, nowShare * 100)}%` }} />
            </div>
            <p className={s.mt}>
              Giving back <span className="num">{storageSize(done)}</span>
            </p>
            <p className={s.ms}>
              {storageCount(job?.filesDone ?? 0)} files cleared · the disk at {Math.round(nowShare * 100)}%
            </p>
          </>
        }
        result={
          warn ? (
            <p className={r.resultTitle}>{phased.failure}</p>
          ) : (
            <>
              <p className={r.count}>{back}</p>
              <p className={r.sub}>back on this server · {Math.round(nowShare * 100)}% full</p>
            </>
          )
        }
        face={
          <>
            <Tick size={13} />
            {back} back
          </>
        }
      />
      <span className={r.srOnly} role="status">
        {phased.said}
      </span>
    </span>
  );
});
