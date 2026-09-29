"use client";
import type { Variable } from "@lume/core/shared";
import s from "./templates.module.css";

/**
 * The variables as chips, right above the text they go into: a click puts one at the caret. Meeting
 * details wait for Calendar, and say so.
 */
export function VariablePicker({
  variables,
  disabled,
  onInsert,
}: {
  variables: Variable[];
  disabled?: boolean;
  onInsert: (token: string) => void;
}) {
  return (
    <div className={s.chips} role="group" aria-label="Variables">
      {variables.map((v) => (
        <button
          key={v.token}
          type="button"
          className={s.chip}
          aria-label={`Insert ${v.label}`}
          title={
            v.needs === "calendar" ? "Needs Calendar, which arrives in a later update" : `{{${v.token}}}`
          }
          disabled={disabled || v.needs === "calendar"}
          // Keep the caret where it is: a chip never takes focus from the text on press.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onInsert(v.token)}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}
