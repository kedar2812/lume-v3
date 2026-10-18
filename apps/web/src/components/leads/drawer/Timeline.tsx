"use client";
import { useId, useState } from "react";
import { AiGlyph } from "@/components/ai/AiGlyph";
import { Button } from "@/components/ui/Button";
import { tokenColor } from "@/lib/leads/colors";
import { relativeTime } from "@/lib/leads/format";
import { describeActivity } from "@/lib/leads/history";
import type { Activity, Catalog } from "@/lib/leads/types";
import x from "./ai.module.css";
import s from "./drawer.module.css";

const TONE: Record<string, string> = { wa: "var(--wa-fill)" };
/** A note, or a logged call with words in it: what LUME AI can read into a next step. */
const said = (a: Activity) => {
  const text = a.type === "note" ? a.payload.body : a.type === "call_logged" ? a.payload.note : null;
  return typeof text === "string" && text.trim() !== "";
};

/** A vertical line of events (the prototype's `.tl`): a coloured dot, what happened, who, and when. */
export function Timeline({
  items,
  catalog,
  hasMore,
  onMore,
  empty,
  tz,
  onSuggest,
}: {
  /** The person's own zone: follow-up times in the history read in it. */
  tz?: string;
  items: Activity[];
  catalog: Catalog;
  hasMore: boolean;
  onMore: () => void;
  empty: string;
  /** With LUME AI on, a "Suggest next step" action on each note and logged call with words in it. */
  onSuggest?: ((a: Activity) => void) | undefined;
}) {
  if (!items.length && !hasMore) return <p className={s.none}>{empty}</p>;
  return (
    <>
      <ol className={s.tl}>
        {items.map((a) => {
          const line = describeActivity(a, catalog, tz);
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
                {onSuggest && said(a) && (
                  <button type="button" className={x.suggest} onClick={() => onSuggest(a)}>
                    <AiGlyph size={14} />
                    Suggest next step
                  </button>
                )}
              </div>
              <time dateTime={a.occurredAt} data-volatile>
                {relativeTime(a.occurredAt, undefined, tz)}
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
