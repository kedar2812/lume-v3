"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { importsClient } from "@/lib/imports/client";
import type { ImportCounts, ImportView } from "@/lib/imports/types";
import s from "./imports.module.css";

const POLL_MS = 2000;
const LIVE = new Set(["queued", "running", "cancelling"]);
const R = 52;
const C = 2 * Math.PI * R;
const n = (v: number) => v.toLocaleString("en");
const handled = (c: ImportCounts) => c.created + c.merged + c.skipped + c.empty + c.errors;

const day = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
/** "June 10, 2024 – February 1, 2025", or one day. */
const span = (a: string, b: string) => (a === b ? day(a) : `${day(a)} – ${day(b)}`);

/** Rows done out of all of them, as a ring with the count in the middle. */
function Ring({ done, total }: { done: number; total: number }) {
  const v = total ? Math.min(1, done / total) : 0;
  return (
    <div className={s.ring}>
      <svg
        viewBox="0 0 120 120"
        width="120"
        height="120"
        role="progressbar"
        aria-label="Rows done"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
      >
        <circle cx="60" cy="60" r={R} fill="none" strokeWidth="8" stroke="var(--line-2)" />
        <circle
          cx="60"
          cy="60"
          r={R}
          fill="none"
          strokeWidth="8"
          stroke="var(--accent)"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - v)}
          transform="rotate(-90 60 60)"
          className={s.ringArc}
        />
      </svg>
      <span className={s.ringText} aria-hidden>
        <b>{n(done)}</b>
        <span>of {n(total)}</span>
      </span>
    </div>
  );
}

/**
 * Step 5 (spec §9.5): the import running, then its report. Polls every 2 s while it's live (a timeout
 * chain, stopped when the sheet closes); the finished report is marked seen once, which clears the dot on
 * Import. No sound: a finished import is administration, not an achievement.
 */
export function ProgressStep({ initial, onClose }: { initial: ImportView; onClose(): void }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const seen = useRef(false);
  const live = LIVE.has(view.status);

  useEffect(() => {
    if (!live) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const r = await importsClient.get(view.id);
      if (stop) return;
      if (r.ok) setView(r.data);
      if (!r.ok || LIVE.has(r.data.status)) timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [live, view.id]);

  useEffect(() => {
    if (live || seen.current || view.seenAt || !view.mine) return;
    seen.current = true;
    void importsClient.seen(view.id);
  }, [live, view.id, view.seenAt, view.mine]);

  const act = async (call: (id: string) => ReturnType<typeof importsClient.get>) => {
    setBusy(true);
    setFailed(null);
    const r = await call(view.id);
    setBusy(false);
    if (r.ok) {
      seen.current = false;
      setView(r.data);
    } else setFailed(r.message);
  };

  const c = view.counts;
  const done = handled(c);
  const one = (v: number, singular: string, plural: string): [number, string] => [
    v,
    v === 1 ? singular : plural,
  ];
  const lines: [number, string][] = [
    [c.created, "created"],
    [c.merged, "merged into existing leads"],
    [c.skipped, "skipped"],
    one(c.empty, "empty row", "empty rows"),
    [c.errors, "with problems"],
    [c.nameFromContact, "used the contact as the name"],
    one(c.phoneNeedsCountry, "needs a country code for its phone", "need a country code for their phone"),
    one(
      c.missingStageFields,
      "is missing fields its stage asks for",
      "are missing fields their stage asks for",
    ),
  ];

  return (
    <>
      <section className={s.body} aria-labelledby="import-run-title" aria-live="polite">
        {live ? (
          <>
            <h3 id="import-run-title" className={s.stepTitle}>
              Importing {view.fileName}
            </h3>
            <div className={s.running}>
              <Ring done={done} total={view.rowCount} />
              <div className={s.liveCounts}>
                <span className={s.countChip} data-tone="ok">
                  {n(c.created)} created
                </span>
                <span className={s.countChip} data-tone="accent">
                  {n(c.merged)} merged
                </span>
                {c.errors > 0 && (
                  <span className={s.countChip} data-tone="danger">
                    {n(c.errors)} with problems
                  </span>
                )}
                <p className={s.lede}>You can close this — LUME will let you know when it&apos;s done.</p>
              </div>
            </div>
          </>
        ) : (
          <>
            {view.status === "done" && c.created + c.merged > 0 && (
              <span className={s.doneMark} aria-hidden>
                <svg viewBox="0 0 24 24" width="22" height="22">
                  <path
                    d="M6 12.5 10 16.5 18 8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            )}
            <h3 id="import-run-title" className={s.stepTitle}>
              {view.status !== "done"
                ? view.fileName
                : c.created + c.merged > 0
                  ? `${view.fileName} is in LUME`
                  : `${view.fileName} was checked — nothing was added`}
            </h3>
            {view.status === "cancelled" && (
              <p className={s.lede}>
                Cancelled after row {n(Math.max(0, view.cursorRow - 1))}. The rows before it are in LUME.
              </p>
            )}
            {view.status === "stopped_access" && (
              <p role="alert" className={`${s.note} ${s.problem}`}>
                LUME stopped this import because your access changed. Ask an admin, then import the rest.
              </p>
            )}
            {view.status === "failed" && (
              <p role="alert" className={`${s.note} ${s.problem}`}>
                LUME couldn’t finish this import:{" "}
                {view.stopReason?.replace(/^failed: /, "") ?? "something went wrong"}
              </p>
            )}
            <ul className={s.report}>
              {lines
                .filter(([v], i) => v > 0 || i === 0)
                .map(([v, label]) => (
                  <li key={label}>{`${n(v)} ${label}`}</li>
                ))}
            </ul>
            {/* Where they count (owner, 2026-10-05): a lead with its own enquiry date is new on that day. */}
            {view.dated && view.dated.n > 0 && (
              <p className={s.note}>
                {view.dated.n === c.created
                  ? c.created === 1
                    ? "It"
                    : `All ${n(c.created)}`
                  : n(view.dated.n)}{" "}
                came with {view.dated.n === 1 ? "its own enquiry date" : "their own enquiry dates"},{" "}
                {span(view.dated.from, view.dated.to)}. {view.dated.n === 1 ? "It counts" : "They count"} on{" "}
                {view.dated.n === 1 ? "that day" : "those days"} in Analytics and in “New today”, not as new
                today.
              </p>
            )}
            <div className={s.reportLinks}>
              {c.created > 0 && (
                <a className={s.linkButton} href={`/leads?source=${view.sourceId}`}>
                  View imported leads
                </a>
              )}
              {c.errors > 0 && view.canSeeRows && (
                <a className={s.linkQuiet} href={`/api/v1/imports/${view.id}/errors.csv`} download>
                  {c.errors === 1
                    ? "Download the row with problems"
                    : `Download the ${n(c.errors)} rows with problems`}
                </a>
              )}
            </div>
            {c.errors > 0 && (
              <p className={s.hintLine}>
                Fix them in your spreadsheet and import that file — rows already in LUME merge, so nothing
                doubles.
              </p>
            )}
          </>
        )}
        {failed && (
          <p role="alert" className={`${s.note} ${s.problem}`}>
            {failed}
          </p>
        )}
      </section>
      <footer className={s.foot}>
        {live && (
          <Button
            variant="ghost"
            loading={busy}
            disabled={view.status === "cancelling"}
            onClick={() => void act(importsClient.cancel)}
          >
            {view.status === "cancelling" ? "Stopping after this batch…" : "Cancel import"}
          </Button>
        )}
        {(view.status === "cancelled" || view.status === "stopped_access") && (
          <Button variant="secondary" loading={busy} onClick={() => void act(importsClient.resume)}>
            Import the rest
          </Button>
        )}
        {view.status === "failed" && (
          <Button variant="secondary" loading={busy} onClick={() => void act(importsClient.resume)}>
            Try again
          </Button>
        )}
        <Button variant="primary" onClick={onClose}>
          {live ? "Close" : "Done"}
        </Button>
      </footer>
    </>
  );
}
