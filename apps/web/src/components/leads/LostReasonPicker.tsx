"use client";
import { useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useCatalog } from "./CatalogProvider";
import s from "./move.module.css";

/**
 * Why a lead was lost: one reason (required, report §6) and an optional note. Used by the drawer, the
 * board and bulk actions, so the question is always asked the same way.
 */
export function LostReasonPicker({
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: (reasonId: string, note: string) => void;
  onCancel: () => void;
}) {
  const { lostReasons } = useCatalog();
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const noteId = useId();
  return (
    <div className={s.stack}>
      <div className={s.chips} role="radiogroup" aria-label="Reason">
        {lostReasons.map((r) => (
          <label key={r.id} className={s.chip} data-on={reason === r.id || undefined}>
            <input
              type="radio"
              name="lost-reason"
              value={r.id}
              checked={reason === r.id}
              onChange={() => setReason(r.id)}
            />
            {r.label}
          </label>
        ))}
        {lostReasons.length === 0 && (
          <p className={s.hint}>There are no lost reasons yet. An admin can add them in Settings.</p>
        )}
      </div>
      <label className={s.field} htmlFor={noteId}>
        Note (optional)
        <input id={noteId} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
      </label>
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      <div className={s.actions}>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={!reason}
          loading={busy}
          onClick={() => reason && onConfirm(reason, note.trim())}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
