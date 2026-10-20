"use client";
import { bytesText } from "@lume/core/shared";
import Link from "next/link";
import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { Skeleton } from "@/components/ui/Skeleton";
import { fold } from "@/components/ui/SearchList";
import { filesClient, type LibraryFile } from "@/lib/files/client";
import { mediaWord } from "@/lib/files/words";
import { FileArt } from "./FileArt";
import p from "./picker.module.css";

const COLUMNS = 3;

/**
 * Choosing from Media (plan 2026-10-20-media-tab, Task 9; canvas Composer): the business's files by their content, in a
 * grid of three. With `multiple`, taps tick files and Attach takes them together; without, a tap picks one. The search
 * box keeps the keyboard: arrows move, Space ticks (before anything's typed), Enter attaches.
 */
export function MediaPicker({
  files: given,
  kinds,
  multiple = false,
  wide = false,
  onPick,
}: {
  /** The files to choose from, when the caller has them already; else Media's list. */
  files?: LibraryFile[];
  /** Only these kinds (a template's header takes a photo, a video or a document, one at a time). */
  kinds?: LibraryFile["kind"][];
  multiple?: boolean;
  /** Inside a sheet or a panel, as wide as it is; otherwise a popover's own width. */
  wide?: boolean;
  onPick(files: LibraryFile[]): void;
}) {
  const [fetched, setFetched] = useState<LibraryFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const listId = useId();
  const files = given ?? fetched;

  useEffect(() => {
    if (given) return;
    let live = true;
    void filesClient.list().then((r) => {
      if (!live) return;
      if (r.ok) setFetched(r.data.files);
      else setError(r.message);
    });
    return () => {
      live = false;
    };
  }, [given]);
  useEffect(() => setActive(0), [query]);

  const usable = (files ?? []).filter((f) => !kinds || kinds.includes(f.kind));
  const q = fold(query.trim());
  const shown = q ? usable.filter((f) => fold(f.name).includes(q)) : usable;
  const picked = chosen.map((id) => usable.find((f) => f.id === id)).filter((f): f is LibraryFile => !!f);

  const choose = (f: LibraryFile) => {
    if (!multiple) return onPick([f]);
    setChosen((c) => (c.includes(f.id) ? c.filter((x) => x !== f.id) : [...c, f.id]));
  };
  const attach = () => picked.length && onPick(picked);

  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS }[e.key];
    // Left and Right move the caret while there are words to edit.
    if (move !== undefined && !(query && Math.abs(move) === 1)) {
      e.preventDefault();
      setActive((i) => Math.max(0, Math.min(shown.length - 1, i + move)));
    } else if (e.key === " " && !query && shown[active]) {
      e.preventDefault();
      choose(shown[active]!);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (picked.length) attach();
      else if (shown[active]) onPick([shown[active]!]);
    }
  };

  const head = (
    <div className={p.head}>
      <b>From Media</b>
      <Link href="/media" className={p.open}>
        Open Media
      </Link>
    </div>
  );

  if (error)
    return (
      <div className={p.picker} data-wide={wide || undefined}>
        {head}
        <p role="alert" className={p.note}>
          {error}
        </p>
      </div>
    );
  if (!files)
    return (
      <div className={p.picker} data-wide={wide || undefined} aria-busy="true" aria-label="Loading Media">
        {head}
        <div className={p.grid}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={84} radius={11} />
          ))}
        </div>
      </div>
    );
  if (usable.length === 0)
    return (
      <div className={p.picker} data-wide={wide || undefined}>
        {head}
        <p className={p.note}>Nothing in Media yet. Files added there can be sent from here.</p>
      </div>
    );

  return (
    <div className={p.picker} data-wide={wide || undefined}>
      {head}
      <label className={p.search}>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="search"
          aria-label="Search Media"
          placeholder="Search Media"
          aria-controls={listId}
          aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={keys}
        />
      </label>
      <ul
        id={listId}
        role="listbox"
        aria-label="Media"
        aria-multiselectable={multiple || undefined}
        className={p.grid}
      >
        {shown.map((f, i) => {
          const on = chosen.includes(f.id);
          return (
            <li
              key={f.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={on}
              aria-label={`${f.name}, ${mediaWord(f)} · ${bytesText(f.size)}`}
              data-active={i === active || undefined}
              className={p.pick}
              onPointerMove={() => setActive(i)}
              // A press keeps focus in the search box, so the panel around it doesn't read the click as leaving.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(f)}
            >
              <span className={p.thumb} data-kind={f.viewAs} data-on={on || undefined}>
                {f.preview === "ready" && f.thumbUrl ? (
                  <img
                    src={f.thumbUrl}
                    alt=""
                    loading="lazy"
                    draggable={false}
                    data-page={f.viewAs !== "image" && f.viewAs !== "video" ? true : undefined}
                  />
                ) : (
                  <FileArt file={f} size="small" />
                )}
                {multiple && (
                  <span className={p.tick} aria-hidden>
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="m6 12.5 4 4 8-9" />
                    </svg>
                  </span>
                )}
              </span>
              <span className={p.name}>{f.name}</span>
              <span className={p.meta}>
                {mediaWord(f)} · {bytesText(f.size)}
              </span>
            </li>
          );
        })}
      </ul>
      {shown.length === 0 && <p className={p.note}>Nothing in Media matches “{query.trim()}”.</p>}
      {multiple && (
        <button type="button" className={p.attach} disabled={!picked.length} onClick={attach}>
          {picked.length === 0
            ? "Attach"
            : `Attach ${picked.length} ${picked.length === 1 ? "file" : "files"}`}
        </button>
      )}
    </div>
  );
}
