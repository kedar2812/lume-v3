"use client";
import s from "./Switch.module.css";

export function Switch({
  checked,
  onChange,
  label,
  labelHidden = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  /** Beside a heading that already says it: the label is for screen readers only. */
  labelHidden?: boolean;
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
      {labelHidden ? <span className={s.srOnly}>{label}</span> : label}
    </button>
  );
}
