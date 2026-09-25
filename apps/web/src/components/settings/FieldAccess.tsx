"use client";
import { useState } from "react";
import type { FieldDefView } from "@/lib/leads/types";
import { accessGone } from "@/lib/settings/access";
import { rolesClient, type FieldAccessLevel, type Role } from "@/lib/settings/roles";
import s from "./settings.module.css";

const LEVELS: [FieldAccessLevel, string][] = [
  ["hidden", "Hidden"],
  ["view", "View"],
  ["edit", "Edit"],
];

/**
 * Which lead fields a role sees: hidden, view-only or editable, one row per field. Every change saves at
 * once. The lead's name is always visible, and the owner always sees and edits everything.
 */
export function FieldAccess({
  role,
  fields,
  onChange,
  onForbidden,
}: {
  role: Role;
  fields: FieldDefView[];
  onChange: (role: Role) => void;
  onForbidden?: () => void;
}) {
  const [entries, setEntries] = useState(role.fieldAccess);
  const [problem, setProblem] = useState<string | null>(null);
  const levelOf = (id: string): FieldAccessLevel => entries.find((e) => e.fieldId === id)?.access ?? "edit";

  const set = async (fieldId: string, access: FieldAccessLevel) => {
    const before = entries;
    const exists = entries.some((e) => e.fieldId === fieldId);
    const next = (
      exists
        ? entries.map((e) => (e.fieldId === fieldId ? { fieldId, access } : e))
        : [...entries, { fieldId, access }]
    ).filter((e) => e.access !== "edit");
    setEntries(next);
    setProblem(null);
    const r = await rolesClient.setFieldAccess(role.id, next);
    if (r.ok) return onChange({ ...role, fieldAccess: r.data.entries });
    setEntries(before);
    if (accessGone(r)) onForbidden?.();
    else setProblem(r.message || "That change couldn’t be saved.");
  };

  return (
    <div className={s.stack}>
      <p className={s.muted}>
        The owner always sees and edits every field. A hidden field is left out of everything people with only{" "}
        {role.name} see.
      </p>
      {problem && (
        <p role="alert" className={s.problem}>
          {problem}
        </p>
      )}
      <table className={s.accessTable}>
        <thead>
          <tr>
            <th scope="col">Field</th>
            {LEVELS.map(([, label]) => (
              <th key={label} scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {fields
            .filter((f) => !f.archived)
            .map((f) => {
              const level = levelOf(f.id);
              return (
                <tr key={f.id} data-level={level}>
                  <th scope="row">
                    {f.label}
                    {f.isCore && <span className={s.you}> · built in</span>}
                  </th>
                  {LEVELS.map(([value, label]) => (
                    <td key={value}>
                      <input
                        type="radio"
                        name={`access-${f.id}`}
                        aria-label={`${f.label}: ${label}`}
                        checked={level === value}
                        disabled={f.key === "name" && value === "hidden"}
                        onChange={() => void set(f.id, value)}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}
