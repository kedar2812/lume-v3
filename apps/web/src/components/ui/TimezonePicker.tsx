"use client";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { localTime, searchTimezones, timezoneOptions, type TimezoneOption } from "@/lib/timezones";
import type { FieldControl } from "./Field";
import s from "./TimezonePicker.module.css";

const LIMIT = 60; // enough to scroll through; typing is faster than scrolling past 400 zones

/**
 * A searchable timezone list that shows each zone's own clock, so the choice can be checked at a
 * glance rather than trusted. Everything LUME calls "today" is measured in the zone chosen here.
 */
export function TimezonePicker({
  value,
  onChange,
  control,
}: {
  value: string;
  onChange: (id: string) => void;
  control: FieldControl;
}) {
  const [query, setQuery] = useState<string | null>(null); // null: showing the selection, not searching
  const [active, setActive] = useState(0);
  const [now, setNow] = useState<Date | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // The clock starts after mount: the server has no idea what time it is where this person is.
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const results = useMemo(
    () => (query === null ? timezoneOptions() : searchTimezones(query)).slice(0, LIMIT),
    [query],
  );
  const selected = timezoneOptions().find((z) => z.id === value);
  const open = query !== null;

  useEffect(() => {
    if (open) listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const choose = (z: TimezoneOption) => {
    onChange(z.id);
    setQuery(null);
  };

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") return setQuery(null);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return setQuery("");
      setActive((i) => Math.min(results.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1))));
      return;
    }
    if (e.key === "Enter" && open) {
      e.preventDefault();
      const pick = results[active];
      if (pick) choose(pick);
    }
  }

  const label = (z: TimezoneOption) => `${z.label} · ${z.offset}`;

  return (
    <div className={s.wrap}>
      <input
        {...control}
        role="combobox"
        aria-expanded={open}
        aria-controls={`${control.id}-list`}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        placeholder="Search for your city"
        value={query ?? (selected ? label(selected) : "")}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onFocus={() => setQuery("")}
        onBlur={() => setQuery(null)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul className={s.list} id={`${control.id}-list`} role="listbox" ref={listRef}>
          {results.map((z, i) => (
            <li key={z.id}>
              {/* mousedown, not click: blur would close the list before a click could land */}
              <button
                type="button"
                role="option"
                aria-selected={z.id === value}
                data-active={i === active || undefined}
                className={s.option}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(z);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span className={s.city}>{z.label}</span>
                <span className={s.zone}>{z.id}</span>
                <span className={s.clock}>
                  {z.offset}
                  {now ? ` · ${localTime(z.id, now)}` : ""}
                </span>
              </button>
            </li>
          ))}
          {results.length === 0 && <li className={s.empty}>No zone matches that. Try a nearby big city.</li>}
        </ul>
      )}
    </div>
  );
}
