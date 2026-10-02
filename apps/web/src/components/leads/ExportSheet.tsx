"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { api } from "@/lib/api";
import s from "./export.module.css";

type Made = { export: { id: string; code: string; rows: number; format: "csv" | "xlsx" } };

/**
 * Export the current Leads view (6B): its filters and its columns, as CSV or Excel. LUME says the promise in one
 * line — every file is marked and traceable, and gone after 24 hours — then hands the file over.
 */
export function ExportSheet({
  label,
  count,
  columns,
  filters,
  onClose,
}: {
  label: string;
  count: number | null;
  columns: string[];
  filters: Record<string, string>;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<"csv" | "xlsx">("csv");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState<Made["export"] | null>(null);
  const link = useRef<HTMLAnchorElement>(null);

  // The file starts downloading as soon as it's made; the link stays for another go.
  useEffect(() => {
    if (made) link.current?.click();
  }, [made]);

  const make = async () => {
    setBusy(true);
    setProblem(null);
    const r = await api.post<Made>("/api/v1/leads/export", { format, label, filters, columns });
    setBusy(false);
    if (!r.ok) return setProblem(r.message);
    setMade(r.data.export);
  };

  return (
    <Dialog label={`Export ${label}`} onClose={onClose}>
      <div className={s.sheet}>
        <h2 className={s.title}>Export {label}</h2>
        <p className={s.what}>
          {count !== null ? `${count.toLocaleString("en-US")} ${count === 1 ? "lead" : "leads"} · ` : ""}
          {columns.length} {columns.length === 1 ? "column" : "columns"}
        </p>
        {!made && (
          <div role="radiogroup" aria-label="Format" className={s.formats}>
            {(
              [
                ["csv", "CSV", "Opens anywhere"],
                ["xlsx", "Excel", "One sheet, with a header"],
              ] as const
            ).map(([value, title, detail]) => (
              <label key={value} className={format === value ? `${s.format} ${s.on}` : s.format}>
                <input
                  type="radio"
                  name="export-format"
                  checked={format === value}
                  onChange={() => setFormat(value)}
                  className={s.radioInput}
                />
                <b>{title}</b> <span>{detail}</span>
              </label>
            ))}
          </div>
        )}
        <p className={s.promise}>
          Each file carries a mark that traces it back to you. It’s deleted after 24 hours.
        </p>
        {problem && (
          <p role="alert" className={s.problem}>
            {problem}
          </p>
        )}
        {made && (
          <p className={s.ready} role="status">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
              <path
                d="M3.5 8.5 6.5 11.5 12.5 4.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Ready · {made.rows.toLocaleString("en-US")} leads · code {made.code}
          </p>
        )}
        <div className={s.actions}>
          <Button variant="ghost" onClick={onClose}>
            {made ? "Done" : "Cancel"}
          </Button>
          {made ? (
            <a ref={link} className={s.download} href={`/api/v1/leads/exports/${made.id}/download`}>
              Download
            </a>
          ) : (
            <Button variant="primary" loading={busy} onClick={() => void make()}>
              Export
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
