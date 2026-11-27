"use client";
import { useId } from "react";
import s from "./SendFrom.module.css";

export type SendFromNumber = { id: string; display: string; whose: string; problem?: string | null };

/**
 * Which WhatsApp number a run sends from (owner 2026-11-26), asked before it starts: one number is named, two or more
 * are a choice with nothing chosen for the person, each saying whose it is; one that can't be used says why.
 */
export function SendFrom({
  numbers,
  value,
  onChange,
}: {
  numbers: SendFromNumber[];
  value: string | null;
  onChange(id: string): void;
}) {
  const id = useId();
  if (!numbers.length) return null;
  if (numbers.length === 1) {
    const n = numbers[0]!;
    return (
      <div className={s.one}>
        <p className={s.line}>
          Sends from {n.display} · {n.whose}
        </p>
        {n.problem && <p className={s.problem}>{n.problem}</p>}
      </div>
    );
  }
  return (
    <div role="radiogroup" aria-labelledby={`${id}-t`} className={s.group}>
      <p id={`${id}-t`} className={s.title}>
        Send from
      </p>
      {numbers.map((n) => (
        <label key={n.id} className={s.option} data-off={n.problem ? "" : undefined}>
          <input
            type="radio"
            name={`${id}-n`}
            value={n.id}
            checked={value === n.id}
            disabled={!!n.problem}
            onChange={() => onChange(n.id)}
            aria-describedby={n.problem ? `${id}-${n.id}` : undefined}
          />
          <span className={s.text}>
            <span className={s.number}>{n.display}</span>
            <span className={s.whose}>{n.whose}</span>
            {n.problem && (
              <span id={`${id}-${n.id}`} className={s.problem}>
                {n.problem}
              </span>
            )}
          </span>
        </label>
      ))}
      {!value && <p className={s.ask}>Choose the number this run sends from</p>}
    </div>
  );
}
