"use client";
import { useEffect, useRef, useState } from "react";
import s from "./live-sheets.module.css";

const COPIED_MS = 2000;

/**
 * The sheet's link, shown whole and ready to copy (owner 2026-11-14): Copy link swaps to a tick and "Copied" for a
 * moment, said to screen readers too; a browser that won't copy selects the link for the person instead.
 */
export function CopyLink({ url }: { url: string }) {
  const [said, setSaid] = useState<"" | "Copied" | "Press Ctrl+C or ⌘C to copy">("");
  const text = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(url);
      setSaid("Copied");
    } catch {
      const sel = window.getSelection();
      if (text.current && sel) sel.selectAllChildren(text.current);
      setSaid("Press Ctrl+C or ⌘C to copy");
    }
    timer.current = setTimeout(() => setSaid(""), COPIED_MS);
  };

  return (
    <div className={s.link}>
      <img className={s.linkMark} src="/brand/google-sheets.png" alt="" width={16} height={16} />
      <span ref={text} className={s.url} title={url}>
        {url}
      </span>
      <button
        type="button"
        className={s.copy}
        aria-label="Copy link"
        data-copied={said === "Copied" || undefined}
        onClick={() => void copy()}
      >
        <span className={s.copyIcon} aria-hidden>
          {said === "Copied" ? (
            <svg viewBox="0 0 16 16">
              <path className={s.copyTick} d="M3.5 8.4 6.6 11.3 12.5 4.9" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16">
              <rect x="5.5" y="5.5" width="8" height="8" rx="2" />
              <path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" />
            </svg>
          )}
        </span>
        <span aria-hidden>{said === "Copied" ? "Copied" : "Copy link"}</span>
      </button>
      <a className={s.open} href={url} target="_blank" rel="noopener noreferrer">
        Open in Google Sheets
      </a>
      <span role="status" className={s.said}>
        {said}
      </span>
    </div>
  );
}
