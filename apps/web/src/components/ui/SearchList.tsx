"use client";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import s from "./SearchList.module.css";

export type ListItem = {
  id: string;
  /** What the option is called ("India"). */
  label: string;
  /** Shown on the right and read after the label ("+91", "INR"). */
  detail?: string;
  /** A country code whose flag stands beside it, or null for none. */
  flag?: string | null;
};

/** Search text without accents or case, so "emirats" finds "Émirats". */
export const fold = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function Flag({ iso }: { iso: string | null | undefined }) {
  const [missing, setMissing] = useState(false);
  if (!iso || missing) return <span className={s.noFlag} aria-hidden />;
  return (
    <img
      src={`/flags/${iso}.svg`}
      alt=""
      width={20}
      height={14}
      loading="lazy"
      decoding="async"
      className={s.flag}
      onError={() => setMissing(true)}
    />
  );
}

/**
 * A searchable list that floats over the page (a portal, fixed), anchored to the control that opened
 * it: inside a scrolling table, drawer or sheet it would otherwise be clipped. Arrows choose, Enter
 * picks, Escape closes it without closing whatever is around it, Tab or a click elsewhere just closes.
 */
export function SearchList({
  anchor,
  search,
  selected,
  searchLabel,
  listLabel,
  placeholder,
  emptyText,
  onPick,
  onClose,
}: {
  anchor: RefObject<HTMLElement | null>;
  /** The items for a query, ranked by the caller (the empty query lists everything). */
  search: (query: string) => ListItem[];
  selected: string | null;
  searchLabel: string;
  listLabel: string;
  placeholder: string;
  /** What to say when a search finds nothing ("No country matches “zz”"). */
  emptyText: (query: string) => string;
  onPick: (item: ListItem) => void;
  /** `true` when focus should go back to the control that opened the list (Escape). */
  onClose: (refocus: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const listId = useId();
  const results = search(query);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const measure = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 328));
      setPlace(
        below < 360 && r.top > below
          ? { left, bottom: window.innerHeight - r.top + 6 }
          : { left, top: r.bottom + 6 },
      );
    };
    measure();
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!anchor.current?.contains(t) && !panel.current?.contains(t)) closeRef.current(false);
    };
    document.addEventListener("pointerdown", away);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [anchor]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, listId]);

  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => Math.max(0, Math.min(results.length - 1, i + step)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = results[active];
      if (item) onPick(item);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // closes the list, not the sheet, drawer or dialog around it
      onClose(true);
    } else if (e.key === "Tab") onClose(false);
  };

  return createPortal(
    <div
      ref={panel}
      className={s.panel}
      data-search-panel=""
      data-up={place?.bottom !== undefined || undefined}
      style={{ position: "fixed", left: place?.left ?? 0, top: place?.top, bottom: place?.bottom }}
    >
      <input
        role="combobox"
        aria-label={searchLabel}
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
        aria-autocomplete="list"
        className={s.search}
        placeholder={placeholder}
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={keys}
      />
      <ul id={listId} role="listbox" aria-label={listLabel} className={s.list}>
        {results.map((item, i) => (
          <li
            key={item.id}
            id={`${listId}-${i}`}
            role="option"
            aria-label={item.detail ? `${item.label} ${item.detail}` : item.label}
            aria-selected={item.id === selected}
            data-active={i === active || undefined}
            className={s.option}
            onPointerMove={() => setActive(i)}
            onClick={() => onPick(item)}
          >
            {item.flag !== undefined && <Flag iso={item.flag} />}
            <span className={s.name}>{item.label}</span>
            {item.detail && <span className={s.detail}>{item.detail}</span>}
            {item.id === selected && (
              <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden className={s.tick}>
                <path
                  d="M3 7.5 6 10.3 11.5 4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </li>
        ))}
      </ul>
      {results.length === 0 && <p className={s.none}>{emptyText(query.trim())}</p>}
    </div>,
    document.body,
  );
}
