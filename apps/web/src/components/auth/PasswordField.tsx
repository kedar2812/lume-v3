"use client";
import { useId, useState } from "react";
import s from "@/components/auth/auth.module.css";

/** One password field, used by reset, invite acceptance and setup: same hint, same show/hide. */
export function PasswordField({
  label,
  name,
  value,
  onChange,
  error,
  autoComplete = "new-password",
}: {
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  autoComplete?: string;
}) {
  const id = useId();
  const [shown, setShown] = useState(false);
  return (
    <div className={s.field}>
      <label htmlFor={id}>{label}</label>
      <span className={s.withReveal}>
        <input
          id={id}
          name={name}
          type={shown ? "text" : "password"}
          autoComplete={autoComplete}
          required
          className={s.input}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : `${id}-hint`}
        />
        <button type="button" className={s.revealBtn} onClick={() => setShown((v) => !v)}>
          {shown ? "Hide" : "Show"}
        </button>
      </span>
      {error ? (
        <p id={`${id}-error`} role="alert" className={s.error}>
          {error}
        </p>
      ) : (
        <p id={`${id}-hint`} className={s.hint}>
          At least 12 characters. A short sentence is easiest to remember.
        </p>
      )}
    </div>
  );
}
