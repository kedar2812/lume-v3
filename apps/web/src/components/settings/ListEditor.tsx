"use client";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/Button";
import s from "./settings.module.css";

export type ListItem = { id: string; label: string };

/**
 * A short list people pick from (lost reasons, tags, packages, stages, a field's options): add at the
 * bottom, rename in place (Enter saves, Escape cancels), reorder by dragging (the handle, or a row's name
 * with a mouse) or with ↑/↓ on a focused handle, and archive only after being asked. Every change is
 * reported at once; the caller saves it. A drag reports once, on the drop, and only when the order changed.
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
  leading,
  askToArchive,
  archiveVerb = "Archive",
  archiveNote = "Leads keep it; it just can’t be picked any more.",
  listLabel,
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
  /** Shown before an item's name (a stage's colour dot). */
  leading?: (item: T) => ReactNode;
  /** Ask about archiving yourself (when it needs a choice, like where a stage's leads go). */
  askToArchive?: (id: string) => void;
  /** What taking an item away is called here: "Archive", or "Remove" when it really goes. */
  archiveVerb?: string;
  archiveNote?: string;
  /** The list's accessible name, when a page holds more than one. */
  listLabel?: string;
}) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [said, setSaid] = useState("");
  const newId = useId();
  const list = useRef<HTMLUListElement>(null);
  const noun = itemLabel.toLowerCase();
  // The latest props, for the window listeners that outlive a render.
  const live = useRef({ items, onReorder });
  live.current = { items, onReorder };

  // ── pointer drag: the row follows the pointer from where it was grabbed; the others slide aside ──
  const pending = useRef<Pending | null>(null);
  const dragRef = useRef<Drag | null>(null);
  useEffect(() => {
    const end = () => {
      pending.current = null;
      dragRef.current = null;
      setDrag(null);
    };
    const onMove = (e: globalThis.PointerEvent) => {
      const p = pending.current;
      if (!p || e.pointerId !== p.pointerId) return;
      let d = dragRef.current;
      if (!d) {
        // A mouse on a row's name: a click's wobble isn't a drag. The handle lifts at once.
        if (!p.now && Math.abs(e.clientY - p.y) < 4) return;
        const rows = [...(list.current?.querySelectorAll<HTMLElement>(":scope > li") ?? [])];
        const slots = rows.map((r) => {
          const b = r.getBoundingClientRect();
          return { top: b.top, height: b.height };
        });
        const from = live.current.items.findIndex((i) => i.id === p.id);
        if (from < 0 || slots.length !== live.current.items.length) return end();
        d = { id: p.id, from, to: from, dy: 0, slots, y: p.y };
      }
      e.preventDefault();
      const { slots, from } = d;
      const me = slots[from]!;
      // Kept inside the list: the row never leaves it.
      const dy = Math.min(
        slots[slots.length - 1]!.top - me.top,
        Math.max(slots[0]!.top - me.top, e.clientY - d.y),
      );
      const middle = me.top + me.height / 2 + dy;
      // Its place is after every row above it whose middle it hasn't risen past, and every row below whose
      // middle it has reached (so pressed against either end of the list, it's first or last).
      const to = slots.filter((x, i) => {
        const mid = x.top + x.height / 2;
        return i < from ? mid < middle : i > from && mid <= middle;
      }).length;
      dragRef.current = { ...d, dy, to };
      setDrag(dragRef.current);
    };
    const onUp = (e: globalThis.PointerEvent) => {
      const p = pending.current;
      if (!p || e.pointerId !== p.pointerId) return;
      const d = dragRef.current;
      end();
      if (!d || d.to === d.from) return;
      const ids = live.current.items.map((i) => i.id);
      if (ids[d.from] !== d.id) return; // the list changed under the drag: nothing is guessed
      ids.splice(d.from, 1);
      ids.splice(d.to, 0, d.id);
      live.current.onReorder?.(ids);
    };
    const onCancel = (e: globalThis.PointerEvent) => {
      if (pending.current && e.pointerId === pending.current.pointerId) end();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && pending.current) {
        e.preventDefault();
        end();
      }
    };
    // Switching away mid-drag (another window, a notification) drops it where it started.
    const onBlur = () => pending.current && end();
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  /** A press that may become a drag: from the handle at once (any pointer), from a row's name with a mouse. */
  const grab = (e: PointerEvent<HTMLElement>, id: string, fromHandle: boolean) => {
    if (!onReorder || items.length < 2 || e.button !== 0 || !e.isPrimary) return;
    if (!fromHandle) {
      if (e.pointerType === "touch") return; // a finger on the name scrolls the page
      if ((e.target as HTMLElement).closest("button, input, select, textarea, a, label")) return;
    }
    if (fromHandle) e.preventDefault(); // no text selection while it moves
    // Held until it's let go, even outside the window, so the drop always arrives and nothing stays lifted.
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // A pointer that's already gone: the window listeners still end the drag.
    }
    pending.current = { id, pointerId: e.pointerId, y: e.clientY, now: fromHandle };
  };

  /** Where a row sits during a drag: the lifted one under the pointer, the rest out of its way. */
  const shift = (i: number): CSSProperties | undefined => {
    if (!drag) return undefined;
    if (i === drag.from) return { transform: `translateY(${drag.dy}px)` };
    const gap = drag.slots[drag.from]!.height;
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return { transform: `translateY(${-gap}px)` };
    if (drag.to < drag.from && i >= drag.to && i < drag.from) return { transform: `translateY(${gap}px)` };
    return { transform: "translateY(0)" };
  };

  const add = () => {
    const label = draft.trim();
    if (!label || !onAdd) return;
    onAdd(label);
    setDraft("");
  };

  const move = (e: KeyboardEvent, index: number) => {
    if ((e.key !== "ArrowUp" && e.key !== "ArrowDown") || !onReorder) return;
    e.preventDefault();
    const to = index + (e.key === "ArrowUp" ? -1 : 1);
    if (to < 0 || to >= items.length) return;
    const ids = items.map((i) => i.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(to, 0, moved!);
    onReorder(ids);
    setSaid(`${items[index]!.label} moved to ${to + 1} of ${items.length}`);
    // Keep the handle focused as the row moves.
    requestAnimationFrame(() => list.current?.querySelectorAll<HTMLElement>("[data-handle]")[to]?.focus());
  };

  return (
    <div className={s.listEditor}>
      <ul ref={list} className={s.rows} aria-label={listLabel} data-dragging={drag ? "" : undefined}>
        {items.map((item, i) => (
          <li
            key={item.id}
            className={s.row}
            data-asking={asking === item.id || undefined}
            data-dragging={drag?.from === i || undefined}
            style={shift(i)}
            onPointerDown={
              editing === item.id || asking === item.id ? undefined : (e) => grab(e, item.id, false)
            }
          >
            {asking === item.id ? (
              <div className={s.ask} role="group" aria-label={`${archiveVerb} ${item.label}?`}>
                <p>
                  <b>
                    {archiveVerb} {item.label}?
                  </b>{" "}
                  {archiveNote}
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
                  {archiveVerb}
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
                    aria-describedby={`${newId}-move`}
                    title="Drag, or press ↑ or ↓, to move"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      grab(e, item.id, true);
                    }}
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
                {leading?.(item)}
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
                    aria-label={`${archiveVerb} ${item.label}`}
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
      {onReorder && (
        <>
          <span id={`${newId}-move`} className={s.srOnly}>
            Press the up or down arrow to move it.
          </span>
          <span className={s.srOnly} aria-live="polite">
            {said}
          </span>
        </>
      )}
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

/** A press on a row, until it moves far enough to be a drag (at once, from the handle). */
type Pending = { id: string; pointerId: number; y: number; now: boolean };
/** A drag under way: the row's place when lifted, where it would land, and every row's slot at that moment. */
type Drag = {
  id: string;
  from: number;
  to: number;
  dy: number;
  y: number;
  slots: { top: number; height: number }[];
};
