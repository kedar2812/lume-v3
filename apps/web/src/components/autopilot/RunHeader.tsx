"use client";
import Link from "next/link";
import { useState } from "react";
import { AiGlyph } from "@/components/ai/AiGlyph";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Kbd } from "@/components/ui/Kbd";
import type { RunDetail, RunsList } from "@/lib/autopilot/types";
import h from "./header.module.css";

const STATUS_WORDS: Record<string, string> = { running: "going", paused: "paused", ended: "done" };

/**
 * The LUME AI page's header (plan 2026-10-28, artboard 1): the run's name, where things stand in one line (LUME AI's
 * Loop drawing only while it works), and what you'd do: Pause all (Esc) or Resume, End run (asked first), New run. With
 * more than one run, a picker names each with how it is. Only the person who started the run, or an admin, controls it.
 */
export function RunHeader({
  run,
  line,
  busy,
  canStart,
  runs,
  onRun,
  onPause,
  onResume,
  onEnd,
}: {
  run: RunDetail["run"];
  line: { text: string; working: boolean };
  /** A control was pressed and its answer isn't back yet. */
  busy: boolean;
  /** May start runs: New run. */
  canStart: boolean;
  runs: RunsList["runs"];
  onRun(runId: string): void;
  onPause(): void;
  onResume(): void;
  onEnd(): void;
}) {
  const [ending, setEnding] = useState(false);
  const control = run.canControl && run.status !== "ended";
  return (
    <section className={h.head} aria-label={run.name}>
      <div className={h.words}>
        {runs.length > 1 && (
          <select className={h.pick} aria-label="Run" value={run.id} onChange={(e) => onRun(e.target.value)}>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {STATUS_WORDS[r.status] ?? r.status}
              </option>
            ))}
          </select>
        )}
        <h2 className={h.name}>{run.name}</h2>
        <p className={h.line} aria-live="polite">
          <AiGlyph size={15} {...(line.working ? { draw: "pen" as const } : {})} />
          <span>{line.text}</span>
        </p>
      </div>
      <div className={h.actions}>
        {control && run.status === "running" && (
          <Button onClick={onPause} disabled={busy} aria-keyshortcuts="Escape" aria-label="Pause all (Esc)">
            Pause all <Kbd>Esc</Kbd>
          </Button>
        )}
        {control && run.status === "paused" && (
          <Button variant="primary" onClick={onResume} disabled={busy}>
            Resume
          </Button>
        )}
        {control && (
          <Button variant="ghost" onClick={() => setEnding(true)} disabled={busy}>
            End run
          </Button>
        )}
        {canStart && (
          <Link href="/leads" className={h.newRun}>
            New run
          </Link>
        )}
      </div>
      {ending && (
        <Dialog label="End this run?" onClose={() => setEnding(false)}>
          <div className={h.confirm}>
            <h2>End this run?</h2>
            <p>Nothing more is sent. Every lead keeps its conversation.</p>
            <div className={h.confirmActions}>
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
