"use client";
import { bytesText } from "@lume/core/shared";
import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { Skeleton } from "@/components/ui/Skeleton";
import { fold } from "@/components/ui/SearchList";
import { filesClient, type LibraryFile } from "@/lib/files/client";
import { fileTypeWord } from "@/lib/files/words";
import s from "./FilePicker.module.css";

const typeOf = (f: LibraryFile) => fileTypeWord(f);

/**
 * The business's files to choose from (plan W3b-1 Task 4): the reply box's "From your files", and the send sheet's
 * "Add a file". A search by name; arrows choose and Enter picks from the search box, as every LUME list does.
 */
export function FilePicker({
  files: given,
  kinds,
  onPick,
}: {
  /** The files to choose from, when the caller has them already (only those shared by link); else LUME's list. */
  files?: LibraryFile[];
  /** Only these kinds (a sheet that can carry only some); every kind when left out. */
  kinds?: LibraryFile["kind"][];
  onPick(file: LibraryFile): void;
}) {
  const [fetched, setFetched] = useState<LibraryFile[] | null>(null);
  const files = given ?? fetched;
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();

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

  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => Math.max(0, Math.min(shown.length - 1, i + step)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const f = shown[active];
      if (f) onPick(f);
    }
  };

  if (error)
    return (
      <p role="alert" className={s.note}>
        {error}
      </p>
    );
  if (!files)
    return (
      <div className={s.picker} aria-busy="true" aria-label="Loading your files">
        {[0, 1, 2].map((i) => (
          <div key={i} className={s.loadingRow}>
            <Skeleton width={30} height={30} radius={7} />
            <Skeleton width={i === 1 ? "48%" : "64%"} height={12} />
          </div>
        ))}
      </div>
    );
  if (usable.length === 0)
    return <p className={s.note}>No files yet. An admin adds them in Settings, under Files.</p>;

  return (
    <div className={s.picker}>
      <input
        type="search"
        className={s.search}
        aria-label="Search your files"
        placeholder="Search your files"
        aria-controls={listId}
        aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={keys}
      />
      <ul id={listId} role="listbox" aria-label="Your files" className={s.list}>
        {shown.map((f, i) => (
          <li
            key={f.id}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            data-active={i === active || undefined}
            className={s.option}
            onPointerMove={() => setActive(i)}
            // A press keeps focus in the search box, so the panel around it doesn't read the click as leaving.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(f)}
          >
            <span className={s.type} data-kind={f.kind} aria-hidden>
              {typeOf(f)}
            </span>
            <span className={s.text}>
              <span className={s.name}>{f.name}</span>
              <span className={s.meta}>
                {typeOf(f)} · {bytesText(f.size)}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {shown.length === 0 && <p className={s.note}>No file matches “{query.trim()}”</p>}
    </div>
  );
}
