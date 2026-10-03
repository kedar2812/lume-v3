import { formatPhone, normalizePhone, type NormalizedPhone } from "../leads/phone";
import { isCheckEmail, isCheckPhone } from "../security/export-code";
import { INTAKE_LIMITS } from "./limits";
import type { ColumnMap, Issue, IntakeField, MapContext, Mapping, Rules } from "./mapping";
import {
  defaultDateOrder,
  defaultDecimalMark,
  detectDateOrder,
  detectDecimalMark,
  fold,
  isScientific,
  parseBoolean,
  parseDate,
  parseMoney,
  parseNumber,
  readEmail,
  readInstagram,
  readUrl,
  splitPhones,
  type DateOrder,
} from "./values";

export type LeadDraft = {
  name: string;
  nameFromContact: boolean;
  phone: NormalizedPhone;
  extraPhones: string[];
  email: string | null;
  instagram: string | null;
  stageId: string | null;
  stageKind: "open" | "won" | "lost" | null;
  ownerId: string | null | undefined;
  value: number | null;
  leadCreatedAt: string | null;
  lostReasonId: string | null;
  custom: Record<string, unknown>;
  tagIds: string[];
};
export type RowOutcome =
  | { kind: "empty" }
  | { kind: "draft"; draft: LeadDraft; warnings: Issue[] }
  | { kind: "error"; problems: Issue[]; warnings: Issue[] };
export type ColumnAnalysis = {
  column: number;
  dateOrder?: DateOrder | "conflict" | "ambiguous";
  decimalMark?: "." | ",";
  unmatched: { value: string; rows: number }[];
};

const TEXT_MAX: Partial<Record<IntakeField["type"], number>> = {
  text: 500,
  long_text: 10_000,
  url: 2000,
  email: 254,
};
const NAME_MAX = 200;
const DATE_TYPES = new Set(["date", "datetime"]);
const MONEY_TYPES = new Set(["currency"]);
const issue = (column: number | null, code: string, message: string): Issue => ({ column, code, message });
const titleCase = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

function applyCase(v: string, c?: "lower" | "title") {
  return c === "lower" ? v.toLowerCase() : c === "title" ? titleCase(v.toLowerCase()) : v;
}

/** The target key a column feeds, or null. */
const keyOf = (c: ColumnMap): string | null => (c.to === "field" ? c.field : null);

function fieldOf(ctx: MapContext, key: string) {
  return ctx.fields.find((f) => f.key === key && !f.archived);
}

/** A raw cell through the column's value map: undefined = not mapped, null = "leave empty". */
function viaMap(c: ColumnMap, raw: string): string | null | undefined {
  if (c.to === "ignore" || !c.transform?.valueMap) return undefined;
  const map = c.transform.valueMap;
  const hit = Object.keys(map).find((k) => fold(k) === fold(raw));
  return hit === undefined ? undefined : map[hit]!;
}

function matchPerson(ctx: MapContext, raw: string) {
  const v = fold(raw);
  const byEmail = ctx.people.filter((p) => fold(p.email) === v);
  if (byEmail.length) return { person: byEmail[0]!, ambiguous: false };
  const byName = ctx.people.filter((p) => fold(p.name) === v);
  const activeByName = byName.filter((p) => p.active);
  if (activeByName.length > 1) return { person: null, ambiguous: true };
  return { person: activeByName[0] ?? byName[0] ?? null, ambiguous: false };
}

const splitter = (c: ColumnMap) => {
  const on = c.to !== "ignore" ? c.transform?.splitOn : undefined;
  return on ? new RegExp(`\\s*\\${on}\\s*`) : /\s*[,;]\s*/;
};

/** Spec §6: one row → a draft lead, or the reasons it can't become one. Never touches a database. */
export function mapRow(cells: string[], m: Mapping, r: Rules, ctx: MapContext): RowOutcome {
  const warnings: Issue[] = [];
  const problems: Issue[] = [];
  let checkRow = false;
  const mapped = m.columns.filter((c) => c.to !== "ignore");
  // trim() also takes off no-break spaces
  const cell = (c: ColumnMap) => (cells[c.column] ?? "").trim();
  if (mapped.every((c) => cell(c) === "")) return { kind: "empty" };
  if (cells.length > ctx.headerCount) {
    const extra = cells.slice(ctx.headerCount).filter((x) => x.trim() !== "");
    if (extra.length)
      warnings.push(issue(null, "EXTRA_CELLS", `${extra.length} cells past the last column were left out.`));
  }
  for (const c of mapped)
    if (cell(c).length > INTAKE_LIMITS.cellChars)
      problems.push(issue(c.column, "CELL_TOO_LONG", "Too long (over 10,000 characters)."));
  if (problems.length) return { kind: "error", problems, warnings };

  const d: LeadDraft = {
    name: "",
    nameFromContact: false,
    phone: { raw: null, e164: null, countryIso: null, status: "missing" },
    extraPhones: [],
    email: null,
    instagram: null,
    stageId: null,
    stageKind: null,
    ownerId: undefined,
    value: null,
    leadCreatedAt: null,
    lostReasonId: null,
    custom: {},
    tagIds: [],
  };
  let first = "";
  let last = "";
  let lostCol: { column: number; raw: string } | null = null;

  for (const c of mapped) {
    const raw0 = cell(c);
    if (raw0 === "") continue;
    const mappedValue = viaMap(c, raw0);
    if (mappedValue === null) continue; // "leave empty"
    const raw = mappedValue ?? raw0;
    if (c.to === "name_part") {
      const v = applyCase(raw.replace(/\s+/g, " "), c.transform?.case);
      if (c.part === "first") first = v;
      else last = v;
      continue;
    }
    if (c.to === "new_field") {
      const f: IntakeField = {
        id: "",
        key: `new:${c.column}`,
        label: c.label,
        type: c.type,
        options: [],
        isCore: false,
        isRequired: false,
        archived: false,
        access: "edit",
      };
      readCustom(f, c, raw, d, ctx, problems, warnings);
      continue;
    }
    const key = keyOf(c)!;
    switch (key) {
      case "name":
        d.name = applyCase(raw.replace(/\s+/g, " "), c.to === "field" ? c.transform?.case : undefined);
        break;
      case "phone": {
        if (isScientific(raw)) {
          d.phone = { raw, e164: null, countryIso: null, status: "invalid" };
          warnings.push(
            issue(
              c.column,
              "PHONE_EXCEL",
              "Excel shortened this number; the full number is lost — re-export the column as text.",
            ),
          );
          break;
        }
        const [one, ...rest] = splitPhones(raw);
        if (isCheckPhone(one)) checkRow = true;
        const country = (c.to === "field" && c.transform?.defaultCountry) || r.defaultCountry;
        d.phone = normalizePhone(one, country);
        if (rest.length) {
          d.extraPhones = rest;
          warnings.push(
            issue(
              c.column,
              "PHONE_EXTRA",
              `Kept ${rest.length === 1 ? "another number" : `${rest.length} more numbers`} in the history: ${rest.join(", ")}.`,
            ),
          );
        }
        if (d.phone.status === "invalid")
          warnings.push(
            issue(
              c.column,
              "PHONE_INVALID",
              `“${one}” isn't a phone number LUME can read; it's kept as typed.`,
            ),
          );
        if (d.phone.status === "needs_country")
          warnings.push(
            issue(c.column, "PHONE_NEEDS_COUNTRY", `“${one}” needs a country code; it's kept as typed.`),
          );
        break;
      }
      case "email":
        if (isCheckEmail(raw)) checkRow = true;
        d.email = readEmail(raw);
        if (!d.email)
          warnings.push(issue(c.column, "EMAIL_INVALID", `Not an email address: “${raw}”. Left empty.`));
        break;
      case "instagram":
        d.instagram = readInstagram(raw);
        if (!d.instagram)
          warnings.push(
            issue(c.column, "INSTAGRAM_INVALID", `Not an Instagram handle: “${raw}”. Left empty.`),
          );
        break;
      case "stage": {
        const s = ctx.stages.find((x) => fold(x.name) === fold(raw));
        if (!s) problems.push(issue(c.column, "STAGE_UNKNOWN", `No stage called “${raw}” in this pipeline.`));
        else {
          d.stageId = s.id;
          d.stageKind = s.kind;
        }
        break;
      }
      case "lost_reason":
        lostCol = { column: c.column, raw };
        break;
      case "owner": {
        const { person, ambiguous } = matchPerson(ctx, raw);
        if (ambiguous)
          problems.push(
            issue(c.column, "OWNER_AMBIGUOUS", `More than one person is called “${raw}”; use their email.`),
          );
        else if (!person || !person.active) {
          if (r.unknownOwner === "error")
            problems.push(issue(c.column, "OWNER_UNKNOWN", `No active person “${raw}”.`));
          else
            warnings.push(
              issue(c.column, "OWNER_UNKNOWN", `No active person “${raw}”; used the owner rule.`),
            );
        } else if (!ctx.canAssign && person.id !== ctx.importerId)
          problems.push(issue(c.column, "CANNOT_ASSIGN", "You can't assign leads to others."));
        else d.ownerId = person.id;
        break;
      }
      case "value": {
        const p = parseMoney(
          raw,
          ctx.decimalMarks[c.column] ?? defaultDecimalMark(ctx.country),
          ctx.currency,
        );
        if (!p.ok) problems.push(issue(c.column, p.issue.code, p.issue.message));
        else {
          d.value = p.value;
          if (p.warning) warnings.push(issue(c.column, p.warning.code, p.warning.message));
        }
        break;
      }
      case "lead_created_at": {
        const p = parseDate(raw, ctx.dateOrders[c.column] ?? defaultDateOrder(ctx.country), ctx);
        if (!p.ok) problems.push(issue(c.column, p.issue.code, p.issue.message));
        else d.leadCreatedAt = p.value.date;
        break;
      }
      case "tags": {
        const ids = new Set<string>();
        for (const part of raw.split(splitter(c)).filter(Boolean)) {
          const t = ctx.tags.find((x) => fold(x.label) === fold(part));
          if (!t) problems.push(issue(c.column, "TAG_UNKNOWN", `No tag called “${part}”.`));
          else ids.add(t.id);
        }
        d.tagIds = [...ids];
        break;
      }
      default: {
        const f = fieldOf(ctx, key);
        if (f) readCustom(f, c, raw, d, ctx, problems, warnings);
      }
    }
  }

  if (first || last) d.name = [first, last].filter(Boolean).join(" ");
  if (lostCol) {
    const reason = ctx.lostReasons.find((x) => fold(x.label) === fold(lostCol!.raw));
    if (d.stageKind !== "lost")
      warnings.push(
        issue(lostCol.column, "LOST_REASON_IGNORED", "A lost reason only applies to a Lost stage; left out."),
      );
    else if (!reason)
      problems.push(issue(lostCol.column, "LOST_REASON_UNKNOWN", `No lost reason called “${lostCol.raw}”.`));
    else d.lostReasonId = reason.id;
  }

  // Required custom fields (amendment 3): a mapped value, else the rules' default, else the row fails.
  for (const f of ctx.fields)
    if (
      !f.isCore &&
      f.isRequired &&
      !f.archived &&
      (d.custom[f.key] === undefined || d.custom[f.key] === null)
    ) {
      const fallback = r.requiredDefaults[f.key];
      if (fallback !== undefined) d.custom[f.key] = fallback;
      else problems.push(issue(null, "REQUIRED_MISSING", `${f.label} is needed on every lead.`));
    }

  if (!d.name) {
    const contact = d.phone.e164
      ? formatPhone(d.phone.e164)
      : (d.phone.raw ?? d.email ?? (d.instagram ? `@${d.instagram}` : null));
    if (r.noName === "error") problems.push(issue(null, "NO_NAME", "No name."));
    else if (!contact) problems.push(issue(null, "NO_NAME_NO_CONTACT", "No name and no contact."));
    else {
      d.name = contact;
      d.nameFromContact = true;
      warnings.push(issue(null, "NAME_FROM_CONTACT", "No name; used the contact instead."));
    }
  }
  if (d.name.length > NAME_MAX)
    problems.push(issue(null, "NAME_TOO_LONG", "Name is longer than 200 characters."));
  // An export brought back in (6B): its made-up check row is never a lead, whatever else the row holds.
  if (checkRow)
    return {
      kind: "error",
      problems: [issue(null, "LUME_CHECK_ROW", "A LUME export's check row: not a real lead")],
      warnings: [],
    };
  return problems.length ? { kind: "error", problems, warnings } : { kind: "draft", draft: d, warnings };
}

function readCustom(
  f: IntakeField,
  c: ColumnMap,
  raw: string,
  d: LeadDraft,
  ctx: MapContext,
  problems: Issue[],
  warnings: Issue[],
) {
  const col = c.column;
  const max = TEXT_MAX[f.type];
  if (max !== undefined && raw.length > max) {
    problems.push(
      issue(col, "VALUE_TOO_LONG", `${f.label} is limited to ${max.toLocaleString("en")} characters.`),
    );
    return;
  }
  const live = f.options.filter((o) => !o.archived);
  const option = (v: string) => live.find((o) => fold(o.label) === fold(v));
  switch (f.type) {
    case "text":
    case "long_text":
      d.custom[f.key] = applyCase(raw, c.to !== "ignore" ? c.transform?.case : undefined);
      return;
    case "number": {
      const p = parseNumber(raw, ctx.decimalMarks[col] ?? defaultDecimalMark(ctx.country));
      if (p.ok) d.custom[f.key] = p.value;
      else problems.push(issue(col, p.issue.code, p.issue.message));
      return;
    }
    case "currency": {
      const p = parseMoney(raw, ctx.decimalMarks[col] ?? defaultDecimalMark(ctx.country), ctx.currency);
      if (!p.ok) problems.push(issue(col, p.issue.code, p.issue.message));
      else {
        d.custom[f.key] = p.value;
        if (p.warning) warnings.push(issue(col, p.warning.code, p.warning.message));
      }
      return;
    }
    case "date":
    case "datetime": {
      const p = parseDate(raw, ctx.dateOrders[col] ?? defaultDateOrder(ctx.country), ctx);
      if (!p.ok) problems.push(issue(col, p.issue.code, p.issue.message));
      else d.custom[f.key] = f.type === "date" ? p.value.date : p.value.instant;
      return;
    }
    case "boolean": {
      const b = parseBoolean(raw);
      if (b === null) problems.push(issue(col, "NOT_YES_NO", `“${raw}” isn't yes or no.`));
      else d.custom[f.key] = b;
      return;
    }
    case "select": {
      const o = option(raw);
      if (!o) problems.push(issue(col, "OPTION_UNKNOWN", `“${raw}” isn't an option for ${f.label}.`));
      else d.custom[f.key] = o.id;
      return;
    }
    case "multi_select": {
      const ids: string[] = [];
      for (const part of raw.split(splitter(c)).filter(Boolean)) {
        const mappedPart = viaMap(c, part);
        if (mappedPart === null) continue;
        const o = option(mappedPart ?? part);
        if (!o) problems.push(issue(col, "OPTION_UNKNOWN", `“${part}” isn't an option for ${f.label}.`));
        else if (!ids.includes(o.id)) ids.push(o.id);
      }
      if (ids.length) d.custom[f.key] = ids;
      return;
    }
    case "phone": {
      const p = normalizePhone(raw, ctx.country);
      if (p.status === "valid") d.custom[f.key] = p.e164;
      else
        warnings.push(
          issue(col, "PHONE_INVALID", `${f.label}: “${raw}” isn't a phone number LUME can read. Left empty.`),
        );
      return;
    }
    case "email": {
      const e = readEmail(raw);
      if (e) d.custom[f.key] = e;
      else warnings.push(issue(col, "EMAIL_INVALID", `${f.label}: not an email address. Left empty.`));
      return;
    }
    case "url": {
      const u = readUrl(raw);
      if (u) d.custom[f.key] = u;
      else warnings.push(issue(col, "URL_INVALID", `${f.label}: not a link. Left empty.`));
      return;
    }
    case "instagram": {
      const h = readInstagram(raw);
      if (h) d.custom[f.key] = h;
      else warnings.push(issue(col, "INSTAGRAM_INVALID", `${f.label}: not an Instagram handle. Left empty.`));
      return;
    }
    case "user": {
      const { person, ambiguous } = matchPerson(ctx, raw);
      if (ambiguous)
        problems.push(
          issue(col, "PERSON_AMBIGUOUS", `More than one person is called “${raw}”; use their email.`),
        );
      else if (!person || !person.active)
        problems.push(issue(col, "PERSON_UNKNOWN", `No active person “${raw}”.`));
      else d.custom[f.key] = person.id;
      return;
    }
  }
}

/** Per mapped column: date order, decimal mark, and the values that don't match (with row counts). */
export function analyzeColumns(rows: string[][], m: Mapping, ctx: MapContext): ColumnAnalysis[] {
  return m.columns.map((c) => {
    const out: ColumnAnalysis = { column: c.column, unmatched: [] };
    if (c.to === "ignore" || c.to === "name_part") return out;
    const values = rows.map((r) => (r[c.column] ?? "").trim()).filter(Boolean);
    const type =
      c.to === "new_field"
        ? c.type
        : c.field === "lead_created_at"
          ? "date"
          : c.field === "value"
            ? "currency"
            : fieldOf(ctx, c.field)?.type;
    if (type && DATE_TYPES.has(type)) out.dateOrder = detectDateOrder(values);
    if (type && (MONEY_TYPES.has(type) || type === "number"))
      out.decimalMark = detectDecimalMark(values, defaultDecimalMark(ctx.country));
    if (c.to !== "field") return out;
    const counts = new Map<string, { value: string; rows: number }>();
    const note = (v: string) => {
      const k = fold(v);
      const e = counts.get(k) ?? { value: v, rows: 0 };
      e.rows++;
      counts.set(k, e);
    };
    const matches = (v: string): boolean => {
      const mv = viaMap(c, v);
      if (mv === null) return true;
      const x = mv ?? v;
      const f = fieldOf(ctx, c.field);
      switch (c.field) {
        case "stage":
          return ctx.stages.some((s) => fold(s.name) === fold(x));
        case "owner":
          return (() => {
            const { person, ambiguous } = matchPerson(ctx, x);
            return !ambiguous && !!person?.active;
          })();
        case "lost_reason":
          return ctx.lostReasons.some((l) => fold(l.label) === fold(x));
        default:
          if (!f) return true;
          if (f.type === "select")
            return (
              f.options.some((o) => !o.archived && fold(o.label) === fold(x)) ||
              (m.addOptions?.[c.field] ?? []).some((l) => fold(l) === fold(x))
            );
          if (f.type === "boolean") return parseBoolean(x) !== null;
          if (f.type === "user") return !!matchPerson(ctx, x).person?.active;
          return true;
      }
    };
    for (const v of values) {
      if (c.field === "tags") {
        for (const part of v.split(splitter(c)).filter(Boolean))
          if (!ctx.tags.some((t) => fold(t.label) === fold(part))) note(part);
      } else if (fieldOf(ctx, c.field)?.type === "multi_select") {
        const f = fieldOf(ctx, c.field)!;
        for (const part of v.split(splitter(c)).filter(Boolean)) {
          const mv = viaMap(c, part);
          if (mv === null) continue;
          const label = mv ?? part;
          const known =
            f.options.some((o) => !o.archived && fold(o.label) === fold(label)) ||
            (m.addOptions?.[c.field] ?? []).some((l) => fold(l) === fold(label));
          if (!known) note(part);
        }
      } else if (!matches(v)) note(v);
    }
    out.unmatched = [...counts.values()]
      .sort((a, b) => b.rows - a.rows || a.value.localeCompare(b.value))
      .slice(0, 50);
    return out;
  });
}

/** Decides each column's date order and decimal mark; a conflicting date column must be chosen by the importer. */
export function resolveColumnSettings(
  analysis: ColumnAnalysis[],
  m: Mapping,
  ctx: Pick<MapContext, "country">,
) {
  const dateOrders: Record<number, DateOrder> = {};
  const decimalMarks: Record<number, "." | ","> = {};
  const blocking: Issue[] = [];
  for (const a of analysis) {
    const c = m.columns.find((x) => x.column === a.column);
    const chosen = c && c.to !== "ignore" ? c.transform?.dateOrder : undefined;
    if (a.dateOrder) {
      if (chosen) dateOrders[a.column] = chosen;
      else if (a.dateOrder === "conflict")
        blocking.push(
          issue(
            a.column,
            "DATE_ORDER_NEEDED",
            "This column has dates like 13/03 and 03/13 — choose how to read them.",
          ),
        );
      else dateOrders[a.column] = a.dateOrder === "ambiguous" ? defaultDateOrder(ctx.country) : a.dateOrder;
    }
    if (a.decimalMark) decimalMarks[a.column] = a.decimalMark;
  }
  return { dateOrders, decimalMarks, blocking };
}
