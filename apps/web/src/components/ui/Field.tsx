"use client";
import { useId, type ReactNode } from "react";
import s from "./Field.module.css";

/** What a field hands its control: the id its label points at, and the wiring for hint and error. */
export type FieldControl = {
  id: string;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
};

/**
 * One labelled field: the label, an optional hint, and an optional error that announces itself.
 * Every form from here on uses this, so a field can never end up unlabelled or silently invalid.
 */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: (control: FieldControl) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const control: FieldControl = {
    id,
    ...(error ? { "aria-invalid": true as const, "aria-describedby": errorId } : {}),
    ...(!error && hint ? { "aria-describedby": hintId } : {}),
  };
  return (
    <div className={s.field}>
      <label htmlFor={id}>{label}</label>
      {children(control)}
      {error ? (
        <p id={errorId} role="alert" className={s.error}>
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className={s.hint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
