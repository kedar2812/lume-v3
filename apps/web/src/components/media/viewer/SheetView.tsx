"use client";
import { Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Sheet } from "./sheet";
import { loadSheets } from "./sheet-load";
import { Toolbar } from "./Toolbar";
import v from "./viewer.module.css";

const n = (x: number) => x.toLocaleString("en-US");

/**
 * An Excel file in LUME's viewer (plan 2026-10-20-media-tab, Task 8; canvas Office): its sheets as tabs under a table
 * with a header that stays put, numbers on the right, and Find in it to show only the rows with a word.
 */
export function SheetView({ src, name }: { src: string; name: string }) {
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState(0);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    setSheets(null);
    setFailed(false);
    loadSheets(src).then(
      (s) => live && setSheets(s),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [src]);

  const sheet = sheets?.[tab] ?? null;
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!sheet || !q) return sheet?.rows ?? [];
    return sheet.rows.filter((r) => r.some((c) => c.toLowerCase().includes(q)));
  }, [sheet, query]);

  if (failed)
    return <p className={v.say}>LUME couldn&apos;t read this spreadsheet. It may be damaged or locked with a password.</p>;
  if (!sheets) return <div className={v.sheetSkeleton} aria-busy="true" aria-label={`Reading ${name}`} />;

  return (
    <div className={v.sheetBox}>
      <Toolbar>
        <button type="button" className={v.tb} aria-pressed={finding} data-on={finding || undefined} onClick={() => setFinding((f) => !f)}>
          <Search size={15} aria-hidden />
          <span className={v.tbWord}>Find in it</span>
        </button>
      </Toolbar>
      {finding && (
        <div className={v.find}>
          <Search size={15} aria-hidden />
          <input
            type="search"
            aria-label={`Find in ${name}`}
            placeholder="Show rows with a word"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setFinding(false);
                setQuery("");
              }
              e.stopPropagation();
            }}
          />
          <span role="status" className={v.findStatus}>
            {query.trim() ? (rows.length ? `${n(rows.length)} ${rows.length === 1 ? "row" : "rows"}` : "Not in this sheet") : ""}
          </span>
          <button
            type="button"
            className={v.tb}
            aria-label="Close Find"
            onClick={() => {
              setFinding(false);
              setQuery("");
            }}
          >
            <X size={15} aria-hidden />
          </button>
        </div>
      )}
      <div className={v.sheet}>
        <div className={v.sheetScroll}>
          {sheet && sheet.header.length ? (
            <table aria-label={sheet.name}>
              <thead>
                <tr>
                  {sheet.header.map((h, i) => (
                    <th key={i} scope="col" data-num={sheet.numeric[i] || undefined}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((c, j) => (
                      <td key={j} data-num={sheet.numeric[j] || undefined}>
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className={v.sayDark}>This sheet is empty.</p>
          )}
          {sheet && sheet.total > sheet.rows.length && (
            <p className={v.sheetNote}>
              Showing the first {n(sheet.rows.length)} rows of {n(sheet.total)}.
            </p>
          )}
        </div>
        {sheets.length > 1 && (
          <div className={v.tabs} role="tablist" aria-label="Sheets">
            {sheets.map((s, i) => (
              <button
                key={s.name}
                type="button"
                role="tab"
                aria-selected={i === tab}
                className={v.tab}
                onClick={() => setTab(i)}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
