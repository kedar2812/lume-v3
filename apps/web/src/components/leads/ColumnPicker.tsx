"use client";
import { Popover } from "@/components/ui/Popover";
import { DEFAULT_COLUMNS, type ColumnDef } from "@/lib/leads/columns";
import s from "./leads.module.css";

/**
 * Which columns, in which order. Name is always first and always on. Reordering uses buttons, not only
 * dragging, so it works from the keyboard and on a phone.
 */
export function ColumnPicker({
  available,
  chosen,
  onChange,
}: {
  available: ColumnDef[];
  chosen: string[];
  onChange: (ids: string[]) => void;
}) {
  const others = available.filter((c) => c.id !== "name");
  const on = chosen.filter((id) => id !== "name" && others.some((c) => c.id === id));
  // Chosen columns first in their order, then the rest as they come.
  const ordered = [
    ...on.map((id) => others.find((c) => c.id === id)!),
    ...others.filter((c) => !on.includes(c.id)),
  ];
  const toggle = (id: string) => onChange(on.includes(id) ? on.filter((x) => x !== id) : [...on, id]);
  const move = (id: string, by: -1 | 1) => {
    const i = on.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= on.length) return;
    const next = [...on];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };

  return (
    <Popover
      label="Columns"
      align="end"
      triggerClassName={s.tool}
      trigger={
        <>
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
            <path
              d="M2.5 3.5h11M2.5 8h11M2.5 12.5h11"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          Columns
        </>
      }
    >
      <ul className={s.pick}>
        <li className={s.pickRow}>
          <label>
            <input type="checkbox" checked disabled />
            Name
          </label>
        </li>
        {ordered.map((c) => {
          const checked = on.includes(c.id);
          const i = on.indexOf(c.id);
          return (
            <li key={c.id} className={s.pickRow}>
              <label>
                <input type="checkbox" checked={checked} onChange={() => toggle(c.id)} />
                {c.label}
              </label>
              {checked && (
                <span className={s.pickMove}>
                  <button
                    type="button"
                    aria-label={`Move ${c.label} up`}
                    disabled={i === 0}
                    onClick={() => move(c.id, -1)}
                  >
                    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden>
                      <path
                        d="M3 7.5 6 4.5l3 3"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${c.label} down`}
                    disabled={i === on.length - 1}
                    onClick={() => move(c.id, 1)}
                  >
                    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden>
                      <path
                        d="M3 4.5 6 7.5l3-3"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className={s.linkish}
        onClick={() => onChange(DEFAULT_COLUMNS.filter((id) => id !== "name"))}
      >
        Reset to default
      </button>
    </Popover>
  );
}
