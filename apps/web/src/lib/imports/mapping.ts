import { INTAKE_LIMITS } from "@lume/core/shared";
import type { ColumnMap, IntakeField, Mapping, Transform } from "./types";

// How a column's destination is written in its <select>. Field keys are [a-z0-9_]; the special choices
// carry a colon (or are prefixed) so a custom field keyed "ignore" can never be mistaken for Ignore.
const SPECIAL = new Set(["ignore", "new_field"]);

export function choiceOf(c: ColumnMap): string {
  if (c.to === "ignore") return "ignore";
  if (c.to === "new_field") return "new_field";
  if (c.to === "name_part") return `name_part:${c.part}`;
  return SPECIAL.has(c.field) ? `field:${c.field}` : c.field;
}
export const fieldChoice = (key: string) => (SPECIAL.has(key) ? `field:${key}` : key);

/**
 * A new field's name, from its column's header. A snake_case header (as Meta's lead ads export writes every form
 * question, "what_type_of_space_are_you_designing?") reads as words with a capital; anything else is kept as the
 * person wrote it. Too long for a field's name, it ends at the last whole word that fits.
 */
export function fieldLabelFrom(header: string): string {
  let label = header.trim();
  if (/_/.test(label) && !/\s/.test(label)) {
    label = label.replace(/_+/g, " ").replace(/\s+/g, " ").trim();
    label = label.charAt(0).toUpperCase() + label.slice(1);
  }
  const max = INTAKE_LIMITS.newFieldLabel;
  if (label.length > max) {
    const cut = label.slice(0, max + 1);
    const lastSpace = cut.lastIndexOf(" ");
    label = (lastSpace > 0 ? cut.slice(0, lastSpace) : label.slice(0, max)).trim();
  }
  return label || "New field";
}

/**
 * The column map for a choice, keeping the transform where it still makes sense. A new field starts as the kind of
 * values its column holds (`suggest`, from every row), else as text.
 */
export function columnFor(
  column: number,
  choice: string,
  header: string,
  before?: ColumnMap,
  suggest?: IntakeField["type"],
): ColumnMap {
  const transform = before && before.to !== "ignore" ? before.transform : undefined;
  const keep = transform ? { transform } : {};
  if (choice === "ignore") return { column, to: "ignore" };
  if (choice === "new_field")
    return { column, to: "new_field", label: fieldLabelFrom(header), type: suggest ?? "text" };
  if (choice === "name_part:first") return { column, to: "name_part", part: "first" };
  if (choice === "name_part:last") return { column, to: "name_part", part: "last" };
  const field = choice.startsWith("field:") ? choice.slice(6) : choice;
  // A value map belongs to the field it was made for; a new destination starts clean.
  const same = before?.to === "field" && before.field === field;
  return { column, to: "field", field, ...(same ? keep : {}) };
}

export function withColumn(m: Mapping, next: ColumnMap): Mapping {
  const columns = m.columns.some((c) => c.column === next.column)
    ? m.columns.map((c) => (c.column === next.column ? next : c))
    : [...m.columns, next].sort((a, b) => a.column - b.column);
  return { ...m, columns };
}

export function withTransform(m: Mapping, column: number, patch: Partial<Transform>): Mapping {
  const c = m.columns.find((x) => x.column === column);
  if (!c || c.to === "ignore") return m;
  const transform = { ...c.transform, ...patch };
  for (const k of Object.keys(transform) as (keyof Transform)[])
    if (transform[k] === undefined) delete transform[k];
  return withColumn(m, { ...c, transform } as ColumnMap);
}

/** What a value the file uses should become: an existing label, nothing ("empty"), or a new option ("add"). */
export function settleValue(
  m: Mapping,
  column: number,
  field: string,
  value: string,
  to: { label: string } | "empty" | "add",
): Mapping {
  const c = m.columns.find((x) => x.column === column);
  if (!c || c.to === "ignore") return m;
  const valueMap = { ...(c.transform?.valueMap ?? {}) };
  delete valueMap[value];
  if (to === "empty") valueMap[value] = null;
  else if (to !== "add") valueMap[value] = to.label;
  const adding = (m.addOptions?.[field] ?? []).filter((l) => l !== value);
  if (to === "add") adding.push(value);
  const addOptions = { ...(m.addOptions ?? {}) };
  if (adding.length) addOptions[field] = adding;
  else delete addOptions[field];
  const next = withTransform(m, column, { valueMap: Object.keys(valueMap).length ? valueMap : undefined });
  return { ...next, ...(Object.keys(addOptions).length ? { addOptions } : { addOptions: undefined }) };
}

/** A field's type as the Columns step treats it (core targets have their own). */
export function targetType(
  c: ColumnMap,
  fields: IntakeField[],
): IntakeField["type"] | "tags" | "stage" | "owner" | "lost_reason" | null {
  if (c.to === "new_field") return c.type;
  if (c.to !== "field") return null;
  if (c.field === "tags" || c.field === "stage" || c.field === "owner" || c.field === "lost_reason")
    return c.field;
  if (c.field === "lead_created_at") return "date";
  return fields.find((f) => f.key === c.field)?.type ?? null;
}
