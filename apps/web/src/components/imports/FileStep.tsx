"use client";
import { useRef, useState } from "react";
import { INTAKE_LIMITS } from "@lume/core/shared";
import { Button } from "@/components/ui/Button";
import { Popover } from "@/components/ui/Popover";
import { ScrollRail } from "@/components/ui/ScrollRail";
import { importsClient } from "@/lib/imports/client";
import type { Delimiter, DraftView, Encoding } from "@/lib/imports/types";
import s from "./imports.module.css";

const ENCODINGS: [Encoding, string][] = [
  ["utf-8", "UTF-8"],
  ["windows-1252", "Windows (Western)"],
  ["utf-16le", "UTF-16"],
];
const DELIMITERS: [Delimiter, string][] = [
  [",", "Comma"],
  [";", "Semicolon"],
  ["\t", "Tab"],
  ["|", "Pipe"],
];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string) => {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};
const TOO_BIG = "This file is over 10 MB. Split it into smaller files.";

/** A menu of choices as a chip ("Encoding: UTF-8"), re-reading the file when one is picked. */
function Choice<T extends string | number>({
  label,
  current,
  options,
  shown,
  onPick,
}: {
  label: string;
  current: T;
  options: [T, string][];
  /** How the chip names the current choice, when not as the menu does. */
  shown?: string;
  onPick: (v: T) => void;
}) {
  const name = shown ?? options.find(([v]) => v === current)?.[1] ?? String(current);
  return (
    <Popover label={label} role="menu" triggerClassName={s.chip} trigger={`${label}: ${name}`}>
      {(close) => (
        <div className={s.menu}>
          {options.map(([v, l]) => (
            <button
              key={String(v)}
              type="button"
              role="menuitemradio"
              aria-checked={v === current}
              className={s.menuItem}
              onClick={() => {
                close();
                if (v !== current) onPick(v);
              }}
            >
              {l}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

/** Step 1 (spec §9.1): the file, and how LUME read it — encoding, separator and header row can be changed. */
export function FileStep({
  draft,
  onDraft,
  onContinue,
}: {
  draft: DraftView | null;
  onDraft(d: DraftView): void;
  onContinue(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const sample = useRef<HTMLDivElement>(null);

  const take = async (file: File | undefined) => {
    if (!file || busy) return;
    setProblem(null);
    if (file.size > INTAKE_LIMITS.bytes) return setProblem(TOO_BIG); // no point sending it
    setBusy(true);
    const r = await importsClient.upload(file);
    setBusy(false);
    if (r.ok) onDraft(r.data);
    else setProblem(r.message);
  };
  const reread = async (p: { encoding?: Encoding; delimiter?: Delimiter; headerRow?: number }) => {
    if (!draft) return;
    setProblem(null);
    const r = await importsClient.patch(draft.id, p);
    if (r.ok) onDraft(r.data);
    else setProblem(r.message);
  };

  return (
    <>
      <section className={s.body} aria-labelledby="import-file-title">
        <h3 id="import-file-title" className={s.stepTitle}>
          Choose a file
        </h3>
        <p className={s.lede}>
          A CSV from a spreadsheet or another CRM, up to 10 MB and {INTAKE_LIMITS.rows.toLocaleString("en")}{" "}
          rows.
        </p>
        <label
          className={s.drop}
          data-over={over || undefined}
          data-busy={busy || undefined}
          data-compact={draft ? true : undefined}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void take(e.dataTransfer.files[0]);
          }}
        >
          <input
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
            className={s.srOnly}
            aria-label="Choose a CSV file"
            onChange={(e) => {
              void take(e.target.files?.[0]);
              e.target.value = ""; // the same file can be chosen again after a fix
            }}
          />
          {!draft && (
            <span className={s.dropIcon} aria-hidden>
              <svg viewBox="0 0 20 20" width="18" height="18">
                <path
                  d="M10 13V4m0 0L6.5 7.5M10 4l3.5 3.5M4 13.5v1A1.5 1.5 0 0 0 5.5 16h9a1.5 1.5 0 0 0 1.5-1.5v-1"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          )}
          <span className={s.dropTitle} aria-live="polite">
            {busy
              ? "Reading the file…"
              : draft
                ? "Choose a different file"
                : "Drop a CSV here, or choose one"}
          </span>
          <span className={s.dropHint}>From Excel or Numbers: save as “CSV UTF-8” first.</span>
        </label>
        {problem && (
          <p role="alert" className={`${s.note} ${s.problem}`}>
            {problem}
          </p>
        )}
        {draft && (
          <div className={s.readout}>
            <p className={s.fileLine}>
              {draft.fileName} · {draft.rowCount.toLocaleString("en")} {draft.rowCount === 1 ? "row" : "rows"}
            </p>
            <div className={s.chips}>
              <Choice
                label="Encoding"
                current={draft.encoding}
                options={ENCODINGS}
                onPick={(encoding) => void reread({ encoding })}
              />
              <Choice
                label="Separator"
                current={draft.delimiter}
                options={DELIMITERS}
                onPick={(delimiter) => void reread({ delimiter })}
              />
              <Choice
                label="Header"
                current={draft.headerRow}
                shown={`row ${draft.headerRow}`}
                options={Array.from({ length: INTAKE_LIMITS.headerSearch }, (_, i) => [
                  i + 1,
                  `Row ${i + 1}`,
                ])}
                onPick={(headerRow) => void reread({ headerRow })}
              />
            </div>
            {draft.fileWarnings.map((w) => (
              <p key={w.code} className={`${s.note} ${s.warn}`}>
                {w.message}
              </p>
            ))}
            {draft.alreadyImported && (
              <p className={`${s.note} ${s.warn}`}>
                This file was already imported on {day(draft.alreadyImported.at)}
                {draft.alreadyImported.by ? ` by ${draft.alreadyImported.by}` : ""}. Importing it again
                matches every row to the lead it made, so nothing is duplicated.
              </p>
            )}
            {/* Every column of the file, across: the rail on top shows there are more and moves to them. */}
            <ScrollRail target={sample} label="Scroll across your columns" className={s.sampleRail} />
            <div className={s.sampleWrap} ref={sample}>
              <table className={s.sample}>
                <caption className={s.srOnly}>The first rows, as LUME read them</caption>
                <thead>
                  <tr>
                    {draft.headers.map((h, i) => (
                      <th key={i} scope="col">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {draft.sample.map((r, i) => (
                    <tr key={i}>
                      {draft.headers.map((_, c) => (
                        <td key={c}>{r[c]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
      <footer className={s.foot}>
        <Button variant="primary" disabled={!draft || busy} onClick={onContinue}>
          Continue
        </Button>
      </footer>
    </>
  );
}
