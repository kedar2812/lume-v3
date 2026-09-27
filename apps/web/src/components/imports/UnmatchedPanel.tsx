"use client";
import { Switch } from "@/components/ui/Switch";
import { settleValue, targetType } from "@/lib/imports/mapping";
import type { ColumnMap, DraftView, Mapping } from "@/lib/imports/types";
import s from "./imports.module.css";

type Option = { value: string; label: string; to: { label: string } | "empty" | "add" };

/**
 * Spec §9.2: every value in the file that doesn't match anything, with how many rows use it, settled one
 * by one — mapped to something that exists, added as a new option, or left empty — before importing.
 */
export function UnmatchedPanel({
  draft,
  mapping,
  onChange,
}: {
  draft: DraftView;
  mapping: Mapping;
  onChange(m: Mapping): void;
}) {
  const columns = draft.analysis
    .map((a) => ({ a, c: mapping.columns.find((x) => x.column === a.column) }))
    .filter((x): x is { a: (typeof draft.analysis)[number]; c: ColumnMap & { to: "field" } } =>
      Boolean(x.a.unmatched.length && x.c?.to === "field"),
    );
  if (!columns.length) return null;

  const optionsFor = (c: ColumnMap & { to: "field" }): Option[] => {
    const type = targetType(c, draft.choices.fields);
    const empty: Option = { value: "empty", label: "Leave empty", to: "empty" };
    if (type === "stage")
      return [
        ...draft.choices.stages.map((st) => ({ value: st.id, label: st.name, to: { label: st.name } })),
        empty,
      ];
    if (type === "owner")
      return [
        ...draft.choices.people.map((p) => ({ value: p.id, label: p.name, to: { label: p.email } })),
        { value: "empty", label: "Use the owner rule", to: "empty" },
      ];
    if (type === "user")
      return [
        ...draft.choices.people.map((p) => ({ value: p.id, label: p.name, to: { label: p.email } })),
        empty,
      ];
    if (type === "boolean")
      return [
        { value: "yes", label: "Yes", to: { label: "yes" } },
        { value: "no", label: "No", to: { label: "no" } },
        empty,
      ];
    if (type === "select" || type === "multi_select") {
      const field = draft.choices.fields.find((f) => f.key === c.field);
      const live = (field?.options ?? []).filter((o) => !o.archived);
      return [
        ...live.map((o) => ({ value: o.id, label: o.label, to: { label: o.label } })),
        ...(draft.can.manageFields
          ? [{ value: "add", label: "Add as a new option", to: "add" as const }]
          : []),
        empty,
      ];
    }
    return [empty];
  };

  /** Which choice a value currently has: added, emptied, or mapped to one of the options. */
  const current = (c: ColumnMap & { to: "field" }, value: string, options: Option[]) => {
    if (mapping.addOptions?.[c.field]?.includes(value)) return "add";
    const mapped = c.transform?.valueMap?.[value];
    if (mapped === null) return "empty";
    if (mapped === undefined) return "";
    return options.find((o) => typeof o.to === "object" && o.to.label === mapped)?.value ?? "";
  };

  return (
    <section className={s.unmatched} aria-label="Values LUME doesn't recognise">
      <h4 className={s.subTitle}>Values LUME doesn’t recognise</h4>
      <p className={s.subLede}>Settle each one. Rows keep a value only once it matches something.</p>
      {columns.map(({ a, c }) => {
        const header = draft.headers[c.column] ?? `Column ${c.column + 1}`;
        if (c.field === "tags")
          return (
            <div key={c.column} className={s.unmatchedGroup}>
              <p className={s.groupName}>{header}</p>
              <p className={s.subLede}>{a.unmatched.map((u) => u.value).join(", ")}</p>
              {draft.can.manageTags ? (
                <Switch
                  label="Create the missing tags"
                  checked={mapping.createMissingTags}
                  onChange={(v) => onChange({ ...mapping, createMissingTags: v })}
                />
              ) : (
                <p className={s.subLede}>
                  Only someone who manages tags can add these; rows using them will be listed as problems.
                </p>
              )}
            </div>
          );
        const options = optionsFor(c);
        return (
          <div key={c.column} className={s.unmatchedGroup}>
            <p className={s.groupName}>{header}</p>
            <ul className={s.valueList}>
              {a.unmatched.map((u) => (
                <li key={u.value} className={s.valueRow}>
                  <span className={s.value}>{u.value}</span>
                  <span className={s.count}>
                    {u.rows} {u.rows === 1 ? "row" : "rows"}
                  </span>
                  <select
                    className={s.select}
                    aria-label={`${u.value} becomes`}
                    value={current(c, u.value, options)}
                    onChange={(e) => {
                      const o = options.find((x) => x.value === e.target.value);
                      if (o) onChange(settleValue(mapping, c.column, c.field, u.value, o.to));
                    }}
                  >
                    <option value="" disabled>
                      Choose…
                    </option>
                    {options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
