"use client";
import { useRef, useState, type ReactNode } from "react";
import type { FieldDefView, Lead } from "@/lib/leads/types";
import { FieldEditor } from "./fields/FieldEditor";
import { valueOf, type SaveOutcome } from "./useLeadEditor";
import s from "./leads.module.css";

/**
 * A table cell you can change in place: a pencil (on hover or focus) or a double-click opens the field's
 * editor over the cell; Enter saves, Escape leaves it as it was. Focus comes back to the pencil after.
 */
export function EditableCell({
  lead,
  def,
  children,
  save,
  error,
  onDismissError,
}: {
  lead: Lead;
  def: FieldDefView;
  children: ReactNode;
  save: (lead: Lead, def: FieldDefView, value: unknown) => Promise<SaveOutcome>;
  error: string | null;
  onDismissError: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const pencil = useRef<HTMLButtonElement>(null);
  const close = () => {
    setEditing(false);
    onDismissError();
    requestAnimationFrame(() => pencil.current?.focus());
  };

  if (editing)
    return (
      <div className={s.editing} data-editing>
        <FieldEditor
          def={def}
          value={valueOf(lead, def)}
          autoFocus
          error={error}
          onCancel={close}
          onCommit={async (v) => {
            const outcome = await save(lead, def, v);
            if (outcome !== "invalid") close();
          }}
        />
      </div>
    );

  return (
    <div className={s.editable} onDoubleClick={() => setEditing(true)}>
      <span className={s.editValue}>{children}</span>
      <button
        ref={pencil}
        type="button"
        className={s.pencil}
        aria-label={`Edit ${def.label} for ${lead.name ?? "this lead"}`}
        onClick={() => setEditing(true)}
      >
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
          <path
            d="M10.5 2.5 13.5 5.5 6 13H3v-3z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}
