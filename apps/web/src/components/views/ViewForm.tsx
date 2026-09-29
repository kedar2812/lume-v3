"use client";
import { useEffect, useId, useState, type FormEvent } from "react";
import { COLOURS } from "@/components/settings/ColourPicker";
import { Button } from "@/components/ui/Button";
import { tokenColor } from "@/lib/leads/colors";
import type { RoleName } from "@/lib/views/client";
import s from "./views.module.css";

export type ViewFormValue = { name: string; color: string; sharedRoleIds: string[] };

/**
 * A view's name, colour and who sees it (4B): one small form for saving a new view and for changing one.
 * Sharing is offered only to someone who manages views.
 */
export function ViewForm({
  initial = { name: "", color: "accent", sharedRoleIds: [] },
  canShare,
  roles,
  onSubmit,
  onDelete,
}: {
  initial?: ViewFormValue;
  canShare: boolean;
  roles: RoleName[] | null;
  /** Resolves to LUME's words when refused, else null. */
  onSubmit: (v: ViewFormValue) => Promise<string | null>;
  onDelete?: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(initial.name);
  const [color, setColor] = useState(initial.color);
  const [share, setShare] = useState(initial.sharedRoleIds.length > 0);
  const [roleIds, setRoleIds] = useState(initial.sharedRoleIds);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setProblem(null), [name, color, share, roleIds]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setProblem("Give the view a name.");
    if (share && !roleIds.length) return setProblem("Pick at least one role, or keep it to yourself.");
    setBusy(true);
    const refused = await onSubmit({ name: name.trim(), color, sharedRoleIds: share ? roleIds : [] });
    setBusy(false);
    if (refused) setProblem(refused);
  };

  return (
    <form className={s.form} onSubmit={(e) => void submit(e)}>
      <label className={s.field}>
        <span>Name</span>
        <input
          aria-label="Name"
          autoFocus
          maxLength={40}
          value={name}
          placeholder="e.g. Chase list"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div role="radiogroup" aria-label="Colour" className={s.swatches}>
        {COLOURS.map(([token, label]) => (
          <label key={token} className={s.swatch} data-on={color === token || undefined}>
            <input
              type="radio"
              name={`${id}-colour`}
              aria-label={label}
              checked={color === token}
              onChange={() => setColor(token)}
            />
            <span style={{ background: tokenColor(token) }} aria-hidden />
          </label>
        ))}
      </div>
      {canShare && (
        <fieldset className={s.who}>
          <legend>Who sees it</legend>
          <label className={s.radio}>
            <input type="radio" name={`${id}-who`} checked={!share} onChange={() => setShare(false)} />
            Just me
          </label>
          <label className={s.radio}>
            <input
              type="radio"
              name={`${id}-who`}
              aria-label="Share with roles"
              checked={share}
              onChange={() => setShare(true)}
            />
            Share with roles
          </label>
          {share && (
            <div className={s.roles}>
              {(roles ?? []).map((r) => {
                const on = roleIds.includes(r.id);
                return (
                  <label key={r.id} className={s.pill} data-on={on || undefined}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setRoleIds((ids) => (on ? ids.filter((x) => x !== r.id) : [...ids, r.id]))
                      }
                    />
                    {r.name}
                  </label>
                );
              })}
            </div>
          )}
        </fieldset>
      )}
      {problem && (
        <p role="alert" className={s.problem}>
          {problem}
        </p>
      )}
      <div className={s.actions}>
        {onDelete && (
          <button type="button" className={s.delete} onClick={onDelete}>
            Delete view
          </button>
        )}
        <Button type="submit" variant="primary" loading={busy}>
          Save
        </Button>
      </div>
    </form>
  );
}
