"use client";
import { ICON_SIZE, UI_ICONS } from "@/components/ui/icons";
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
            <UI_ICONS.done size={ICON_SIZE.md} aria-hidden />
          ) : (
            <UI_ICONS.copy size={ICON_SIZE.md} aria-hidden />
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
