"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { importsClient } from "@/lib/imports/client";
import type { DraftView, ImportView, Issue, Outcome, PreviewRow } from "@/lib/imports/types";
import { COLUMN_CODES, type Step } from "./ImportSheet";
import s from "./imports.module.css";

const ORDER: Outcome[] = ["create", "merge", "skip", "error", "empty"];
const CHIP: Record<Outcome, string> = {
  create: "Create",
  merge: "Merge",
  skip: "Skip",
  error: "Problem",
  empty: "Empty",
};

/** "3 create · 1 merge · 2 error": the outcomes that happen, in a fixed order, zeros left out. */
export const summaryLine = (summary: Partial<Record<Outcome, number>>) =>
  ORDER.filter((o) => (summary[o] ?? 0) > 0)
    .map((o) => `${summary[o]} ${o}`)
    .join(" · ");

function mergeText(r: PreviewRow): string | null {
  const m = r.mergeInto;
  if (!m) return null;
  const verb = r.outcome === "skip" ? "Matches" : "Merges into";
  if ("row" in m) return `${verb} row ${m.row}`;
  if (!m.visible) return `${verb} an existing lead`; // one the importer can't see: never who or whose
  return `${verb} ${m.name}${m.ownerName ? ` (${m.ownerName})` : ""}`;
}

/** Where a refused Start sends you: the step that owns the first problem. */
function fixStep(details: unknown): Step {
  const first = Array.isArray(details) ? (details[0] as Issue | undefined) : undefined;
  return first && !COLUMN_CODES.has(first.code) ? "rules" : "columns";
}

/** Step 4 (spec §9.4): exactly what Start would do with the first rows, and every problem in the file. */
export function PreviewStep({
  draft,
  onFix,
  onStarted,
  onContinue,
}: {
  draft: DraftView;
  onFix(to: Step): void;
  onStarted?(v: ImportView): void;
  /** A sheet's wizard (2B) continues to its last step instead of starting an import. */
  onContinue?(): void;
}) {
  const [rows, setRows] = useState<PreviewRow[] | null>(null);
  const [summary, setSummary] = useState<Partial<Record<Outcome, number>>>({});
  const [errorsOnly, setErrorsOnly] = useState<{ scanned: number } | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ message: string; to: Step } | null>(null);
  const [starting, setStarting] = useState(false);
  const started = useRef(false);

  const load = useCallback(
    async (onlyErrors: boolean) => {
      setRows(null);
      setLoadFailed(null);
      const r = await importsClient.preview(draft.id, onlyErrors ? { errorsOnly: true } : {});
      if (!r.ok) return setLoadFailed(r.message);
      setRows(r.data.rows);
      if (onlyErrors) setErrorsOnly({ scanned: r.data.scanned });
      else {
        setErrorsOnly(null);
        setSummary(r.data.summary);
      }
    },
    [draft.id],
  );
  useEffect(() => void load(false), [load]);

  const start = async () => {
    if (started.current) return; // a double press sends one Start
    started.current = true;
    setStarting(true);
    setRefused(null);
    const r = await importsClient.start(draft.id);
    if (r.ok) return onStarted?.(r.data);
    started.current = false;
    setStarting(false);
    setRefused({ message: r.message, to: fixStep("details" in r ? r.details : undefined) });
  };

  const rowsLabel = `${draft.rowCount.toLocaleString("en")} ${draft.rowCount === 1 ? "row" : "rows"}`;
  return (
    <>
      <section className={s.body} aria-labelledby="import-preview-title">
        <h3 id="import-preview-title" className={s.stepTitle}>
          Check before importing
        </h3>
        <p className={s.lede}>
          {errorsOnly
            ? errorsOnly.scanned && rows?.length
              ? `LUME checked all ${errorsOnly.scanned.toLocaleString("en")} rows: ${rows.length === 20 ? "these are the first 20 with" : `${rows.length} ${rows.length === 1 ? "has" : "have"}`} problems.`
              : `LUME checked all ${errorsOnly.scanned.toLocaleString("en")} rows: no problems.`
            : "What LUME will do with the first rows. The whole file is checked the same way when it runs."}
        </p>
        {!errorsOnly && rows && summaryLine(summary) && <p className={s.summary}>{summaryLine(summary)}</p>}
        {refused && (
          <div role="alert" className={`${s.note} ${s.problem} ${s.refusal}`}>
            <span>{refused.message}</span>
            <Button size="sm" onClick={() => onFix(refused.to)}>
              {refused.to === "rules" ? "Back to Rules" : "Back to Columns"}
            </Button>
          </div>
        )}
        {loadFailed && (
          <p role="alert" className={`${s.note} ${s.problem}`}>
            {loadFailed}
          </p>
        )}
        <div className={s.tableWrap}>
          <table className={s.preview} aria-busy={!rows || undefined}>
            <caption className={s.srOnly}>What each row will do</caption>
            <thead>
              <tr>
                <th scope="col">Row</th>
                <th scope="col">Outcome</th>
                <th scope="col">Lead</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {!rows &&
                !loadFailed &&
                Array.from({ length: 4 }, (_, i) => (
                  <tr key={i}>
                    <td colSpan={4}>
                      <Skeleton height={18} />
                    </td>
                  </tr>
                ))}
              {rows?.map((r) => (
                <tr key={r.rowNumber}>
                  <td className={s.num}>{r.rowNumber}</td>
                  <td>
                    <span className={s.outcome} data-outcome={r.outcome}>
                      {CHIP[r.outcome]}
                    </span>
                  </td>
                  <td>
                    <div className={s.leadCell}>
                      {r.name ?? <span className={s.muted}>—</span>}
                      {mergeText(r) && <span className={s.mergeLine}>{mergeText(r)}</span>}
                      {r.alsoMatches > 0 && (
                        <span className={s.mergeLine}>
                          Also matches {r.alsoMatches} more {r.alsoMatches === 1 ? "lead" : "leads"}
                        </span>
                      )}
                    </div>
                  </td>
                  <td>
                    <div className={s.notes}>
                      {r.problems.map((p, i) => (
                        <span key={`p${i}`} className={s.noteProblem}>
                          {p.message}
                        </span>
                      ))}
                      {r.warnings.map((w, i) => (
                        <span key={`w${i}`} className={s.noteWarn}>
                          {w.message}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={s.previewActions}>
          {errorsOnly ? (
            <Button size="sm" variant="ghost" onClick={() => void load(false)}>
              Back to the first rows
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => void load(true)}>
              Show rows with problems
            </Button>
          )}
        </div>
      </section>
      <footer className={s.foot}>
        <p className={s.footNote}>
          {onContinue
            ? "Rows with problems are listed on the sheet's page, and tried again when the sheet changes."
            : "Rows with problems are left out and listed in the report."}
        </p>
        {onContinue ? (
          <Button variant="primary" disabled={!rows && !loadFailed} onClick={onContinue}>
            Continue
          </Button>
        ) : (
          <Button
            variant="primary"
            loading={starting}
            disabled={!rows && !loadFailed}
            onClick={() => void start()}
          >
            Import {rowsLabel}
          </Button>
        )}
      </footer>
    </>
  );
}
