"use client";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { liveSheetsClient, PAUSES, type LiveSheetView } from "@/lib/live-sheets/client";
import { ago } from "@/lib/sheets/format";
import { CopyLink } from "./CopyLink";
import { SheetProgress, type ProgressPhase } from "./SheetProgress";
import s from "./live-sheets.module.css";

const STATUS_WORDS: Record<LiveSheetView["status"], string> = {
  making: "Making",
  live: "Live",
  updating: "Updating",
  paused: "Paused",
};
const n = (v: number) => v.toLocaleString("en-US");

/** Where a sheet's run stands, as the bar shows it; null when nothing is running. */
export function phaseOf(sheet: LiveSheetView): ProgressPhase | null {
  const r = sheet.run;
  if (!r || (r.status !== "queued" && r.status !== "running")) return null;
  if (sheet.lastError) return "slow";
  if (sheet.status === "making" && r.total === 0) return "making";
  return r.total > 0 ? "writing" : "making";
}

/**
 * One live sheet on the Live sheets page (spec 2026-11-14 §1): what it holds, where it stands and when it last updated,
 * its link to copy, and what can be done with it. A paused one says why, with its own fix.
 */
export function LiveSheetCard({
  sheet,
  canTakeOver,
  onChange,
  onEdit,
  onDeleted,
}: {
  sheet: LiveSheetView;
  /** Someone who manages people: may run a sheet as themselves. */
  canTakeOver: boolean;
  onChange(sheet: LiveSheetView): void;
  onEdit(sheet: LiveSheetView): void;
  onDeleted(id: string): void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const phase = phaseOf(sheet);
  const pause = sheet.status === "paused" && sheet.pauseReason ? PAUSES[sheet.pauseReason] : null;

  const act = async (
    name: string,
    call: () => Promise<{ ok: true; data: { sheet: LiveSheetView } } | { ok: false; message: string }>,
  ) => {
    setBusy(name);
    setProblem(null);
    const r = await call();
    setBusy(null);
    if (!r.ok) return setProblem(r.message);
    onChange(r.data.sheet);
  };
  const reconnect = async () => {
    setBusy("connect");
    const r = await liveSheetsClient.connectStart();
    if (!r.ok) {
      setBusy(null);
      return setProblem(r.message);
    }
    window.location.assign(r.data.url);
  };

  return (
    <article className={s.card} data-status={sheet.status} aria-labelledby={`ls-${sheet.id}`}>
      <header className={s.cardHead}>
        <span className={s.sheetMark} aria-hidden>
          <img src="/brand/google-sheets.png" alt="" />
        </span>
        <div>
          <h2 id={`ls-${sheet.id}`} className={s.name}>
            {sheet.name}
          </h2>
          <p className={s.rule}>{sheet.ruleWords}</p>
        </div>
        <span className={s.status} data-status={sheet.status}>
          {STATUS_WORDS[sheet.status]}
        </span>
      </header>

      <ul className={s.facts}>
        <li>
          <strong>{n(sheet.leadCount)}</strong> {sheet.leadCount === 1 ? "lead" : "leads"}
        </li>
        <li>{sheet.preset === "meta" ? "Meta audience" : "Your own columns"}</li>
        <li>{sheet.edits === "keep" ? "Keeps edits made in the sheet" : "Puts LUME's back over edits"}</li>
        {sheet.lastSyncedAt && <li>Updated {ago(sheet.lastSyncedAt, Date.now())}</li>}
      </ul>
      {sheet.capped && (
        <p className={s.note}>
          More leads match than one sheet holds, so it keeps the newest {n(sheet.leadCount)}.
        </p>
      )}

      {phase && (
        <SheetProgress
          key={`${sheet.id}-${sheet.run?.status}`}
          phase={phase}
          total={sheet.run?.total ?? 0}
          written={sheet.run?.written ?? 0}
        />
      )}
      {!phase && sheet.lastError && !pause && <p className={s.slow}>{sheet.lastError}</p>}

      {pause && (
        <div className={s.pause}>
          <p>{pause.words}</p>
          {pause.fix === "connect" && (
            <div>
              <Button
                size="sm"
                variant="secondary"
                loading={busy === "connect"}
                onClick={() => void reconnect()}
              >
                Connect Google again
              </Button>
            </div>
          )}
          {pause.fix === "remake" && sheet.canChange && (
            <div>
              <Button
                size="sm"
                variant="secondary"
                loading={busy === "remake"}
                onClick={() => void act("remake", () => liveSheetsClient.remake(sheet.id))}
              >
                Make it again
              </Button>
            </div>
          )}
          {pause.fix === "take_over" && canTakeOver && (
            <div>
              <Button
                size="sm"
                variant="secondary"
                loading={busy === "take"}
                onClick={() => void act("take", () => liveSheetsClient.takeOver(sheet.id))}
              >
                Take it over
              </Button>
            </div>
          )}
          {pause.fix === "plan" && (
            <div>
              <a className={s.open} href="/settings/about#plan">
                See your plan
              </a>
            </div>
          )}
        </div>
      )}

      {sheet.url && <CopyLink url={sheet.url} />}
      {problem && (
        <p role="alert" className={s.problem}>
          {problem}
        </p>
      )}

      <footer className={s.actions}>
        <Button
          size="sm"
          variant="ghost"
          loading={busy === "run"}
          disabled={sheet.status === "paused" || !!phase}
          onClick={() => void act("run", () => liveSheetsClient.run(sheet.id))}
        >
          Update now
        </Button>
        {/* Someone else's sheet: Update now and the link only (the API refuses the rest: bug hunt 2026-11-17). */}
        {sheet.canChange && (
          <Button size="sm" variant="ghost" onClick={() => onEdit(sheet)}>
            Edit
          </Button>
        )}
        {!sheet.canChange ? null : sheet.pauseReason === "paused_by_person" ? (
          <Button
            size="sm"
            variant="ghost"
            loading={busy === "resume"}
            onClick={() => void act("resume", () => liveSheetsClient.resume(sheet.id))}
          >
            Resume
          </Button>
        ) : (
          sheet.status !== "paused" && (
            <Button
              size="sm"
              variant="ghost"
              loading={busy === "pause"}
              onClick={() => void act("pause", () => liveSheetsClient.pause(sheet.id))}
            >
              Pause
            </Button>
          )
        )}
        <span className={s.grow} />
        {sheet.canChange && (
          <Button size="sm" variant="ghost" onClick={() => setDeleting(true)}>
            Delete
          </Button>
        )}
      </footer>

      {deleting && (
        <DeleteSheet
          sheet={sheet}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setDeleting(false);
            onDeleted(sheet.id);
          }}
        />
      )}
    </article>
  );
}

function DeleteSheet({
  sheet,
  onClose,
  onDeleted,
}: {
  sheet: LiveSheetView;
  onClose(): void;
  onDeleted(): void;
}) {
  const [trash, setTrash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setProblem(null);
    const r = await liveSheetsClient.remove(sheet.id, trash);
    setBusy(false);
    if (!r.ok) return setProblem(r.message);
    onDeleted();
  };
  return (
    <Dialog label={`Delete “${sheet.name}”`} onClose={busy ? () => undefined : onClose}>
      <div className={s.form}>
        <h2 className={s.name}>Delete “{sheet.name}”?</h2>
        <p className={s.lede}>
          LUME stops updating it. The sheet stays in Google Drive{sheet.url ? ", as it is now" : ""}, unless
          you move it to Google&apos;s bin too.
        </p>
        {sheet.url && (
          <label className={s.check}>
            <input
              type="checkbox"
              checked={trash}
              onChange={(e) => setTrash(e.target.checked)}
              disabled={busy}
            />
            Also move the sheet to Google&apos;s bin
          </label>
        )}
        {problem && (
          <p role="alert" className={s.problem}>
            {problem}
          </p>
        )}
        <div className={s.foot}>
          <span className={s.grow} />
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void go()}>
            Delete live sheet
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
