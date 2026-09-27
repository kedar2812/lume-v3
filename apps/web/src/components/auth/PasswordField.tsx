"use client";
import { useId } from "react";
import s from "@/components/auth/auth.module.css";
import { PasswordInput } from "@/components/ui/PasswordInput";

/** One password field, used by reset, invite acceptance and setup: same hint, same eye, same Caps Lock hint. */
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
  return (
    <div className={s.field}>
      <label htmlFor={id}>{label}</label>
      <PasswordInput
        id={id}
        name={name}
        autoComplete={autoComplete}
        required
        className={s.input}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : `${id}-hint`}
      />
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
