"use client";
import s from "./Switch.module.css";

export function Switch({
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
      role="switch"
      aria-checked={checked}
      className={s.switch}
      onClick={() => onChange(!checked)}
    >
      <span className={s.track} aria-hidden />
      {label}
    </button>
  );
}
