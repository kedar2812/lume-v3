"use client";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import s from "./settings.module.css";

export type ListItem = { id: string; label: string };

/**
 * A short list people pick from (lost reasons, tags, packages, stages, a field's options): add at the
 * bottom, rename in place (Enter saves, Escape cancels), reorder with the handle or Alt+↑/↓, and
 * archive only after being asked. Every change is reported at once; the caller saves it.
 */
export function ListEditor<T extends ListItem>({
  items,
  itemLabel,
  addLabel,
  onAdd,
  onRename,
  onReorder,
  onArchive,
  renderExtra,
  askToArchive,
  archiveNote = "Leads keep it; it just can’t be picked any more.",
}: {
  items: T[];
  /** What one item is called ("Reason"): used in every control's name. */
  itemLabel: string;
  addLabel: string;
  onAdd?: (label: string) => void;
  onRename?: (id: string, label: string) => void;
  onReorder?: (ids: string[]) => void;
  onArchive?: (id: string) => void;
  renderExtra?: (item: T) => ReactNode;
  /** Ask about archiving yourself (when it needs a choice, like where a stage's leads go). */
  askToArchive?: (id: string) => void;
  archiveNote?: string;
}) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const newId = useId();
  const list = useRef<HTMLUListElement>(null);
  const noun = itemLabel.toLowerCase();

  const add = () => {
    const label = draft.trim();
    if (!label || !onAdd) return;
    onAdd(label);
    setDraft("");
  };

  const move = (e: KeyboardEvent, index: number) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown") || !onReorder) return;
    e.preventDefault();
    const to = index + (e.key === "ArrowUp" ? -1 : 1);
    if (to < 0 || to >= items.length) return;
    const ids = items.map((i) => i.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(to, 0, moved!);
    onReorder(ids);
    // Keep the handle focused as the row moves.
    requestAnimationFrame(() => list.current?.querySelectorAll<HTMLElement>("[data-handle]")[to]?.focus());
  };

  return (
    <div className={s.listEditor}>
      <ul ref={list} className={s.rows}>
        {items.map((item, i) => (
          <li key={item.id} className={s.row} data-asking={asking === item.id || undefined}>
            {asking === item.id ? (
              <div className={s.ask} role="group" aria-label={`Archive ${item.label}?`}>
                <p>
                  <b>Archive {item.label}?</b> {archiveNote}
                </p>
                <Button size="sm" variant="ghost" onClick={() => setAsking(null)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    setAsking(null);
                    onArchive?.(item.id);
                  }}
                >
                  Archive
                </Button>
              </div>
            ) : (
              <>
                {onReorder && (
                  <button
                    type="button"
                    data-handle
                    className={s.handle}
                    aria-label={`Move ${item.label}`}
                    title="Alt + ↑ or ↓ to move"
                    onKeyDown={(e) => move(e, i)}
                  >
                    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
                      <path
                        d="M4 3h.01M8 3h.01M4 6h.01M8 6h.01M4 9h.01M8 9h.01"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                )}
                {editing === item.id ? (
                  <input
                    className={s.rename}
                    aria-label={`${itemLabel} name`}
                    defaultValue={item.label}
                    autoFocus
                    maxLength={80}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setEditing(null);
                      } else if (e.key === "Enter") {
                        e.preventDefault();
                        const label = e.currentTarget.value.trim();
                        setEditing(null);
                        if (label && label !== item.label) onRename?.(item.id, label);
                      }
                    }}
                    onBlur={() => setEditing(null)}
                  />
                ) : (
                  <span className={s.label}>{item.label}</span>
                )}
                {renderExtra?.(item)}
                {onRename && editing !== item.id && (
                  <button
                    type="button"
                    className={s.iconBtn}
                    aria-label={`Rename ${item.label}`}
                    onClick={() => setEditing(item.id)}
                  >
                    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
                      <path
                        d="M10.5 2.5 13.5 5.5 6 13H3v-3z"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                )}
                {(onArchive || askToArchive) && (
                  <button
                    type="button"
                    className={s.iconBtn}
                    aria-label={`Archive ${item.label}`}
                    onClick={() => (askToArchive ? askToArchive(item.id) : setAsking(item.id))}
                  >
                    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
                      <path
                        d="M2.5 4h11v2h-11zM3.5 6v7h9V6M6.5 8.5h3"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      {onAdd && (
        <form
          method="post"
          className={s.addRow}
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <label htmlFor={newId} className={s.srOnly}>
            New {noun}
          </label>
          <input
            id={newId}
            className={s.addInput}
            placeholder={`${addLabel}…`}
            maxLength={80}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={!draft.trim()}>
            Add
          </Button>
        </form>
      )}
    </div>
  );
}
