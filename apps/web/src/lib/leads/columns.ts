import type { Catalog } from "./types";

export type ColumnDef = {
  id: string;
  label: string;
  width: number;
  /** The field this column shows, when it shows one (drives field access and inline editing). */
  fieldKey?: string;
  /** The API sort this column's header switches to. */
  sortable?: "name" | "updated";
  align?: "end";
};

const CORE: ColumnDef[] = [
  { id: "name", label: "Name", width: 240, fieldKey: "name", sortable: "name" },
  { id: "stage", label: "Stage", width: 150 },
  { id: "owner", label: "Owner", width: 170 },
  { id: "phone", label: "Phone", width: 170, fieldKey: "phone" },
  { id: "email", label: "Email", width: 220, fieldKey: "email" },
  { id: "instagram", label: "Instagram", width: 150, fieldKey: "instagram" },
  { id: "value", label: "Value", width: 120, fieldKey: "value", align: "end" },
  { id: "tags", label: "Tags", width: 170 },
  { id: "created", label: "Enquiry date", width: 130, fieldKey: "lead_created_at" },
  { id: "updated", label: "Last activity", width: 130, sortable: "updated" },
];
const CONTACT = new Set(["phone", "email", "instagram"]);
export const DEFAULT_COLUMNS = ["name", "stage", "owner", "phone", "value", "updated"];

/**
 * What this person may add to their table. A masked role gets no contact column at all (report §12.2 #4),
 * and nobody gets a column for a field hidden from them.
 */
export function availableColumns(cat: Catalog, contactsVisible: boolean): ColumnDef[] {
  const visible = (key?: string) => !key || cat.fields.find((f) => f.key === key)?.access !== "hidden";
  const core = CORE.filter((c) => (contactsVisible || !CONTACT.has(c.id)) && visible(c.fieldKey));
  const custom = cat.fields
    .filter((f) => !f.isCore && !f.archived && f.access !== "hidden")
    .map((f) => ({ id: `custom:${f.key}`, label: f.label, width: 170, fieldKey: f.key }));
  return [...core, ...custom];
}

/** Saved order first, unknown ids dropped, and the name always the first column. */
export function resolveColumns(saved: string[] | null, available: ColumnDef[]): ColumnDef[] {
  const byId = new Map(available.map((c) => [c.id, c]));
  const name = byId.get("name");
  const ids = [...new Set(saved ?? DEFAULT_COLUMNS)].filter((id) => id !== "name" && byId.has(id));
  return [...(name ? [name] : []), ...ids.map((id) => byId.get(id)!)];
}

const KEY = (userId: string) => `lume.leads.columns.${userId}`;

/** A per-person convenience kept in this browser; losing it only means the default columns come back. */
export function loadColumnChoice(userId: string): string[] | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY(userId)) ?? "null");
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null;
  } catch {
    return null;
  }
}

export function saveColumnChoice(userId: string, ids: string[]): void {
  try {
    localStorage.setItem(KEY(userId), JSON.stringify(ids));
  } catch {
    /* private mode: the choice lasts until reload */
  }
}
