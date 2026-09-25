"use client";
import { useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { tokenColor } from "@/lib/leads/colors";
import { relativeTime } from "@/lib/leads/format";
import { describeActivity } from "@/lib/leads/history";
import type { Activity, Catalog } from "@/lib/leads/types";
import s from "./drawer.module.css";

const TONE: Record<string, string> = { wa: "var(--wa-fill)" };

/** A vertical line of events (the prototype's `.tl`): a coloured dot, what happened, who, and when. */
export function Timeline({
  items,
  catalog,
  hasMore,
  onMore,
  empty,
}: {
  items: Activity[];
  catalog: Catalog;
  hasMore: boolean;
  onMore: () => void;
  empty: string;
}) {
  if (!items.length && !hasMore) return <p className={s.none}>{empty}</p>;
  return (
    <>
      <ol className={s.tl}>
        {items.map((a) => {
          const line = describeActivity(a, catalog);
          return (
            <li key={a.id} className={s.ti}>
              <span
                className={s.tiDot}
                style={{ background: TONE[line.tone] ?? tokenColor(line.tone) }}
                aria-hidden
              />
              <div className={s.tiBody}>
                <b>{line.title}</b>
                {line.detail && <p>{line.detail}</p>}
                {line.quote && <div className={s.quote}>{line.quote}</div>}
              </div>
              <time dateTime={a.occurredAt} data-volatile>
                {relativeTime(a.occurredAt)}
              </time>
            </li>
          );
        })}
      </ol>
      {hasMore && (
        <div className={s.moreRow}>
          <Button size="sm" onClick={onMore}>
            Load earlier
          </Button>
        </div>
      )}
    </>
  );
}

/** Notes: a composer above the notes, newest first. ⌘/Ctrl+Enter adds. */
export function NoteComposer({
  onAdd,
  disabled,
}: {
  onAdd: (body: string) => Promise<boolean>;
  disabled?: boolean;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const id = useId();
  const add = async () => {
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    if (await onAdd(text)) setBody("");
    setBusy(false);
  };
  return (
    <form
      method="post"
      className={s.composer}
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <label htmlFor={id} className={s.srOnly}>
        Write a note
      </label>
      <textarea
        id={id}
        data-note-input
        rows={2}
        placeholder="Write a note…"
        maxLength={5000}
        value={body}
        disabled={disabled}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void add();
          }
        }}
      />
      <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!body.trim() || disabled}>
        Add note
      </Button>
    </form>
  );
}
