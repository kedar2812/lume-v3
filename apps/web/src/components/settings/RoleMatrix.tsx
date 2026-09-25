"use client";
import { useId, useState } from "react";
import { accessGone } from "@/lib/settings/access";
import { rolesClient, type Grant, type PermissionDef, type Role, type Scope } from "@/lib/settings/roles";
import s from "./settings.module.css";

const SCOPES: [Scope, string, string][] = [
  ["own", "Own", "their own"],
  ["team", "Team", "their team’s"],
  ["all", "All", "everyone’s"],
];
const scopeWords = (scope: Scope | null) => SCOPES.find(([k]) => k === scope)?.[2];

/**
 * What a role can do: every permission, grouped by area, as a tick with a scope (own, team, all) where
 * the permission has one. Each change saves the whole grant list at once; a refusal (like granting more
 * than the editor holds) puts the row back and says why. A summary at the top reads the role back.
 */
export function RoleMatrix({
  role,
  catalog,
  onChange,
  onForbidden,
}: {
  role: Role;
  catalog: PermissionDef[];
  onChange: (role: Role) => void;
  onForbidden?: () => void;
}) {
  const [grants, setGrants] = useState<Grant[]>(role.grants);
  const [problem, setProblem] = useState<string | null>(null);
  const summaryId = useId();

  const groups = [...new Set(catalog.map((p) => p.group))].map((g) => ({
    name: g,
    items: catalog.filter((p) => p.group === g),
  }));
  const held = (key: string) => grants.find((g) => g.key === key);

  const save = async (next: Grant[]) => {
    const before = grants;
    setGrants(next);
    setProblem(null);
    const r = await rolesClient.patch(role.id, { grants: next });
    if (r.ok) return onChange(r.data.role);
    setGrants(before);
    if (accessGone(r)) onForbidden?.();
    else setProblem(r.message || "That change couldn’t be saved.");
  };

  const granted = catalog.filter((p) => held(p.key));

  return (
    <div className={s.matrix}>
      <section className={s.summary} aria-labelledby={summaryId}>
        <h3 id={summaryId} className={s.summaryTitle}>
          What {role.name} can do
        </h3>
        {granted.length === 0 ? (
          <p className={s.muted}>
            Nothing yet. People with only this role can sign in and see an empty LUME.
          </p>
        ) : (
          <ul className={s.summaryList}>
            {granted.map((p) => {
              const words = scopeWords(held(p.key)!.scope);
              return (
                <li key={p.key}>
                  <span>{p.label}</span>
                  {words && <span className={s.summaryScope}> · {words}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {problem && (
        <p role="alert" className={s.problem}>
          {problem}
        </p>
      )}

      {groups.map((group) => (
        <fieldset key={group.name} className={s.permGroup}>
          <legend>{group.name}</legend>
          {group.items.map((p) => {
            const g = held(p.key);
            const id = `perm-${p.key}`;
            return (
              <div key={p.key} className={s.permRow} data-on={g ? true : undefined}>
                <input
                  id={id}
                  type="checkbox"
                  checked={!!g}
                  aria-describedby={`${id}-d`}
                  onChange={(e) =>
                    void save(
                      e.target.checked
                        ? [...grants, { key: p.key, scope: p.scoped ? "own" : null }]
                        : grants.filter((x) => x.key !== p.key),
                    )
                  }
                />
                <div className={s.permText}>
                  <label htmlFor={id} className={s.permLabel}>
                    {p.label}
                  </label>
                  <span id={`${id}-d`} className={s.permHint}>
                    {p.description}
                  </span>
                </div>
                {p.scoped && g && (
                  <select
                    className={s.scopeSelect}
                    aria-label={`${p.label}: scope`}
                    value={g.scope ?? "own"}
                    onChange={(e) =>
                      void save(
                        grants.map((x) => (x.key === p.key ? { ...x, scope: e.target.value as Scope } : x)),
                      )
                    }
                  >
                    {SCOPES.map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}
