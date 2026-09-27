import type { FieldType } from "../leads/custom-fields";
import { fold, type DateOrder } from "./values";

export type Transform = {
  case?: "lower" | "title";
  dateOrder?: DateOrder;
  defaultCountry?: string;
  valueMap?: Record<string, string | null>;
  splitOn?: "," | ";" | "|";
};
export type ColumnMap =
  | { column: number; to: "ignore" }
  | { column: number; to: "field"; field: string; transform?: Transform }
  | { column: number; to: "name_part"; part: "first" | "last"; transform?: Transform }
  | { column: number; to: "new_field"; label: string; type: FieldType; transform?: Transform };
export type Mapping = {
  columns: ColumnMap[];
  createMissingTags: boolean;
  addOptions?: Record<string, string[]>;
}; // addOptions: field key → labels to create at Start
export type OwnerRule =
  { mode: "unassigned" } | { mode: "user"; userId: string } | { mode: "round_robin"; userIds: string[] };
export type Rules = {
  matchOn: ("phone" | "email" | "instagram")[];
  onMatch: "merge" | "skip" | "duplicate";
  reopenClosedTo: string | null;
  pipelineId: string;
  stageId: string;
  owner: OwnerRule;
  defaultCountry: string | null;
  noName: "use_contact" | "error";
  unknownOwner: "fallback" | "error";
  requiredDefaults: Record<string, unknown>;
};
export type IntakeField = {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  options: { id: string; label: string; archived?: boolean }[];
  isCore: boolean;
  isRequired: boolean;
  archived: boolean;
  access: "edit" | "view" | "hidden";
};
export type MapContext = {
  fields: IntakeField[];
  stages: { id: string; name: string; kind: "open" | "won" | "lost" }[];
  people: { id: string; name: string; email: string; active: boolean }[];
  tags: { id: string; label: string }[];
  lostReasons: { id: string; label: string }[];
  currency: string;
  country: string | null;
  today: string;
  timezone: string;
  importerId: string;
  canAssign: boolean;
  canManageFields: boolean;
  canManageTags: boolean;
  headerCount: number;
  dateOrders: Record<number, DateOrder>;
  decimalMarks: Record<number, "." | ",">;
};
export type Issue = { column: number | null; code: string; message: string };

/** Targets that aren't field definitions but can take a column. */
export const PSEUDO_TARGETS = [
  { key: "tags", label: "Tags" },
  { key: "lost_reason", label: "Lost reason" },
] as const;

const usable = (f: IntakeField) => !f.archived && f.access === "edit" && f.key !== "source";

export const MAPPABLE_TARGETS = (fields: IntakeField[]) => [
  ...fields.filter(usable).map((f) => ({
    key: f.key,
    label: f.label,
    group: (["phone", "email", "instagram"].includes(f.key) ? "Contact" : f.isCore ? "Lead" : "Custom") as
      "Contact" | "Lead" | "Custom",
  })),
  ...PSEUDO_TARGETS.map((t) => ({ ...t, group: "Lead" as const })),
];

export const DEFAULT_RULES = (o: { pipelineId: string; stageId: string; country: string | null }): Rules => ({
  matchOn: ["phone", "email", "instagram"],
  onMatch: "merge",
  reopenClosedTo: null,
  pipelineId: o.pipelineId,
  stageId: o.stageId,
  owner: { mode: "unassigned" },
  defaultCountry: o.country,
  noName: "use_contact",
  unknownOwner: "fallback",
  requiredDefaults: {},
});

/** Header words → target key. Folded, punctuation removed. "source" is deliberately absent (amendment 4). */
const SYNONYMS: Record<string, string> = {
  name: "name",
  "full name": "name",
  "client name": "name",
  "lead name": "name",
  "customer name": "name",
  contact: "name",
  phone: "phone",
  mobile: "phone",
  "mobile no": "phone",
  "mobile number": "phone",
  "phone number": "phone",
  whatsapp: "phone",
  "whatsapp number": "phone",
  "contact number": "phone",
  cell: "phone",
  tel: "phone",
  telephone: "phone",
  email: "email",
  "e mail": "email",
  "email address": "email",
  mail: "email",
  instagram: "instagram",
  ig: "instagram",
  "instagram handle": "instagram",
  "instagram username": "instagram",
  insta: "instagram",
  owner: "owner",
  "assigned to": "owner",
  "handled by": "owner",
  "sales rep": "owner",
  rep: "owner",
  agent: "owner",
  stage: "stage",
  status: "stage",
  "pipeline stage": "stage",
  value: "value",
  amount: "value",
  "deal value": "value",
  price: "value",
  revenue: "value",
  date: "lead_created_at",
  created: "lead_created_at",
  "created at": "lead_created_at",
  "date created": "lead_created_at",
  timestamp: "lead_created_at",
  "submitted at": "lead_created_at",
  "enquiry date": "lead_created_at",
  tags: "tags",
  tag: "tags",
  labels: "tags",
  "lost reason": "lost_reason",
  "reason lost": "lost_reason",
};
const NAME_PARTS: Record<string, "first" | "last"> = {
  "first name": "first",
  firstname: "first",
  "given name": "first",
  "last name": "last",
  lastname: "last",
  surname: "last",
  "family name": "last",
};

const clean = (h: string) =>
  fold(h)
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function suggestMapping(headers: string[], fields: IntakeField[], memory?: Mapping | null): Mapping {
  const targets = new Map(MAPPABLE_TARGETS(fields).map((t) => [t.key, t]));
  const used = new Set<string>();
  const columns: ColumnMap[] = headers.map((h, column) => {
    const remembered = memory?.columns.find((c) => c.column === column);
    if (remembered && remembered.to !== "ignore") {
      if (remembered.to === "field" && targets.has(remembered.field) && !used.has(remembered.field)) {
        used.add(remembered.field);
        return { ...remembered, column };
      }
      if (remembered.to === "name_part" && !used.has(`name_part:${remembered.part}`)) {
        used.add(`name_part:${remembered.part}`);
        return { ...remembered, column };
      }
    }
    const key = clean(h);
    const part = NAME_PARTS[key];
    if (part && !used.has(`name_part:${part}`) && !used.has("name")) {
      used.add(`name_part:${part}`);
      return { column, to: "name_part", part };
    }
    const byLabel = [...targets.values()].find(
      (t) => clean(t.label) === key || t.key === key.replace(/ /g, "_"),
    );
    const target = SYNONYMS[key] ?? byLabel?.key;
    if (
      target &&
      targets.has(target) &&
      !used.has(target) &&
      !(target === "name" && (used.has("name_part:first") || used.has("name_part:last")))
    ) {
      used.add(target);
      return { column, to: "field", field: target };
    }
    return { column, to: "ignore" };
  });
  return { columns, createMissingTags: memory?.createMissingTags ?? false };
}

const issue = (column: number | null, code: string, message: string): Issue => ({ column, code, message });

/** Spec §5.3–§5.4 and amendment 3. Empty means the import may start. */
export function validateMapping(m: Mapping, r: Rules, ctx: MapContext): Issue[] {
  const out: Issue[] = [];
  const byKey = new Map(ctx.fields.map((f) => [f.key, f]));
  const seen = new Set<string>();
  const pseudo = new Set<string>(PSEUDO_TARGETS.map((t) => t.key));
  let first = false;
  let last = false;
  const newLabels = new Set<string>();
  for (const c of m.columns) {
    if (c.to === "field") {
      if (c.field === "source")
        out.push(
          issue(
            c.column,
            "SOURCE_NOT_MAPPABLE",
            "Source is the import itself. Map this column to a new field instead.",
          ),
        );
      else if (!pseudo.has(c.field)) {
        const f = byKey.get(c.field);
        if (!f || f.archived) out.push(issue(c.column, "UNKNOWN_FIELD", "That field no longer exists."));
        else if (f.access !== "edit")
          out.push(issue(c.column, "FIELD_NOT_EDITABLE", `Your role can't fill in ${f.label}.`));
      }
      if (seen.has(c.field)) out.push(issue(c.column, "FIELD_TWICE", "Two columns go to the same field."));
      seen.add(c.field);
    }
    if (c.to === "name_part") {
      if (c.part === "first") first = true;
      else last = true;
    }
    if (c.to === "new_field") {
      const label = fold(c.label);
      if (!ctx.canManageFields)
        out.push(issue(c.column, "NEW_FIELD_NOT_ALLOWED", "Your role can't create fields."));
      if (!label) out.push(issue(c.column, "NEW_FIELD_LABEL_TAKEN", "Give the new field a name."));
      else if (ctx.fields.some((f) => !f.archived && fold(f.label) === label) || newLabels.has(label))
        out.push(issue(c.column, "NEW_FIELD_LABEL_TAKEN", `A field called “${c.label}” already exists.`));
      newLabels.add(label);
    }
  }
  for (const [key, labels] of Object.entries(m.addOptions ?? {})) {
    const f = byKey.get(key);
    if (!labels.length) continue;
    if (!ctx.canManageFields)
      out.push(issue(null, "NEW_OPTION_NOT_ALLOWED", "Your role can't add options to fields."));
    else if (!f || f.archived || (f.type !== "select" && f.type !== "multi_select"))
      out.push(issue(null, "UNKNOWN_FIELD", "Options can only be added to a choice field."));
  }
  if (m.createMissingTags && !ctx.canManageTags)
    out.push(issue(null, "NEW_TAG_NOT_ALLOWED", "Your role can't create tags."));
  if (last && !first) out.push(issue(null, "LAST_WITHOUT_FIRST", "Map a first-name column too."));
  if (seen.has("name") && (first || last))
    out.push(issue(null, "FIELD_TWICE", "Name is mapped twice (a name column and name parts)."));
  if (r.noName === "error" && !seen.has("name") && !first)
    out.push(
      issue(null, "NO_NAME_COLUMN", "Map a name column, or let rows without a name use their contact."),
    );
  for (const f of ctx.fields)
    if (
      !f.isCore &&
      f.isRequired &&
      !f.archived &&
      !seen.has(f.key) &&
      r.requiredDefaults[f.key] === undefined
    )
      out.push(
        issue(
          null,
          "REQUIRED_FIELD_UNCOVERED",
          `${f.label} is needed on every lead: map a column to it or choose a default.`,
        ),
      );

  const stage = ctx.stages.find((s) => s.id === r.stageId);
  if (!stage) out.push(issue(null, "UNKNOWN_STAGE", "Choose the stage new leads enter."));
  if (r.reopenClosedTo !== null && ctx.stages.find((s) => s.id === r.reopenClosedTo)?.kind !== "open")
    out.push(issue(null, "REOPEN_NOT_OPEN", "Closed leads can only reopen to an open stage."));
  const active = (id: string) => ctx.people.some((p) => p.id === id && p.active);
  if (r.owner.mode === "user") {
    if (!active(r.owner.userId)) out.push(issue(null, "OWNER_INACTIVE", "That person can't take leads."));
    else if (!ctx.canAssign && r.owner.userId !== ctx.importerId)
      out.push(issue(null, "CANNOT_ASSIGN", "Your role can only give imported leads to you."));
  }
  if (r.owner.mode === "round_robin") {
    if (!r.owner.userIds.length) out.push(issue(null, "ROUND_ROBIN_EMPTY", "Choose who takes turns."));
    else if (r.owner.userIds.some((id) => !active(id)))
      out.push(issue(null, "OWNER_INACTIVE", "Someone chosen to take turns can't take leads."));
    else if (!ctx.canAssign && r.owner.userIds.some((id) => id !== ctx.importerId))
      out.push(issue(null, "CANNOT_ASSIGN", "Your role can only give imported leads to you."));
  }
  if (!r.matchOn.length && r.onMatch !== "duplicate")
    out.push(issue(null, "MATCH_ON_EMPTY", "Choose at least one way to recognise an existing lead."));
  return out;
}
