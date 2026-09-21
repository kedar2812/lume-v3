"use client";
import s from "./CheckCircle.module.css";

/** The round "mark done" control: the tick draws itself and a ring ripples out (spec §5.3). */
export function CheckCircle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      className={s.check}
      onClick={() => onChange(!checked)}
    >
      <svg viewBox="0 0 12 12" aria-hidden>
        <path d="M2.5 6.3 5 8.6l4.6-5" />
      </svg>
    </button>
  );
}
