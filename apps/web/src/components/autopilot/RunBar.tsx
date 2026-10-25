"use client";
import { useState } from "react";
import { AiGlyph } from "@/components/ai/AiGlyph";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Kbd } from "@/components/ui/Kbd";
import { Odometer } from "@/components/ui/Odometer";
import { ProgressRing } from "@/components/ui/ProgressRing";
import type { RunDetail } from "@/lib/autopilot/types";
import type { runCounts, runStatus } from "@/lib/autopilot/words";
import s from "./live.module.css";

const fmt = (n: number) => n.toLocaleString("en-US");
/** Whole percent, rounded down from the counts themselves: 100% only once every lead is messaged. */
const percent = (done: number, of: number) => (of ? Math.floor((done * 100) / of) : 0);

/**
 * The run bar (spec 2026-10-19 §2): LUME AI's mark drawing like a pen while it works (resting when it isn't), the run's
 * name and what it's doing in words, its counts, how far through it is, what's waiting for a tap, and Pause (Esc),
 * Resume and End run for the person who started it or an admin. Ending asks first.
 */
export function RunBar({
  detail,
  status,
  counts,
  asks,
  busy,
  onPause,
  onResume,
  onEnd,
  onOpenAsks,
}: {
  detail: RunDetail;
  status: ReturnType<typeof runStatus>;
  counts: ReturnType<typeof runCounts>;
  /** Ask me items waiting (§2.1). */
  asks: number;
  /** A control was pressed and its answer isn't back yet. */
  busy: boolean;
  onPause(): void;
  onResume(): void;
  onEnd(): void;
  onOpenAsks(): void;
}) {
  const { run } = detail;
  const [ending, setEnding] = useState(false);
  const control = run.canControl && run.status !== "ended";
  return (
    <section className={s.bar} aria-label={run.name}>
      <div className={s.barMark} data-working={status.working || undefined}>
        <AiGlyph size={30} draw={status.working ? "pen" : undefined} />
      </div>
      <div className={s.barWords}>
        <h2 className={s.barName}>{run.name}</h2>
        <p className={s.barStatus} aria-live="polite">
          <b>{status.title}</b>
          {status.line && <span>{status.line}</span>}
        </p>
      </div>
      <ul className={s.counts} aria-label="This run so far">
        {(
          [
            ["Messaged", counts.messaged],
            ["Replied", counts.replied],
            ["Ready for you", counts.ready],
            ["Stopped", counts.stopped],
          ] as const
        ).map(([label, value]) => (
          <li key={label}>
            <Odometer value={value} format={fmt} label={label} />
            <span aria-hidden>{label}</span>
          </li>
        ))}
      </ul>
      <ProgressRing
        size={40}
        value={counts.done}
        color="var(--accent)"
        label={`${fmt(counts.messaged)} of ${fmt(counts.inRun)} messaged`}
      >
        {percent(counts.messaged, counts.inRun)}%
      </ProgressRing>
      <div className={s.barActions}>
        {asks > 0 && (
          <button type="button" className={s.asksPill} onClick={onOpenAsks}>
            {fmt(asks)} waiting for you
          </button>
        )}
        {control && run.status === "running" && (
          <Button
            size="sm"
            onClick={onPause}
            disabled={busy}
            aria-keyshortcuts="Escape"
            aria-label="Pause (Esc)"
          >
            Pause <Kbd>Esc</Kbd>
          </Button>
        )}
        {control && run.status === "paused" && (
          <Button size="sm" variant="primary" onClick={onResume} disabled={busy}>
            Resume
          </Button>
        )}
        {control && (
          <Button size="sm" variant="ghost" onClick={() => setEnding(true)} disabled={busy}>
            End run
          </Button>
        )}
      </div>
      {ending && (
        <Dialog label="End this run?" onClose={() => setEnding(false)}>
          <div className={s.confirm}>
            <h2>End this run?</h2>
            <p>Nothing more is sent. Every lead keeps its conversation.</p>
            <div className={s.confirmActions}>
              <Button onClick={() => setEnding(false)}>Keep it going</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setEnding(false);
                  onEnd();
                }}
              >
                End run
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}
