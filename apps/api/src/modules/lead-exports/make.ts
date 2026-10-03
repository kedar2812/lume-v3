import { and } from "drizzle-orm";
import ExcelJS from "exceljs";
import type { FastifyRequest } from "fastify";
import Papa from "papaparse";
import { formatPhone, maskEmail, maskInstagram, maskPhone } from "@lume/core";
import { schema } from "@lume/db";
import { safeCell } from "../../export/service";
import { HttpError } from "../../http/errors";
import { loadFieldRegistry, type FieldRegistry } from "../../leads/fields";
import { leadFilters, orderBy, type FilterQuery } from "../leads/query";
import { isFieldVisible, serializeLead, type LeadView } from "../leads/serialize";

/** Most leads in one file (plan ruling B1): more is "Narrow the view". */
const DEFAULT_CAP = 25_000;
let cap = DEFAULT_CAP;
/** Tests only: a smaller cap, or null for the default. */
export function setExportCapForTests(n: number | null): void {
  cap = n ?? DEFAULT_CAP;
}

type Cell = string | number | null;
type Lookups = {
  stages: Map<string, string>;
  people: Map<string, string>;
  tags: Map<string, string>;
  tz: string;
};
type Column = {
  id: string;
  header: string;
  cell: (v: LeadView, l: Lookups) => Cell;
  contact?: "phone" | "email" | "name";
};

const display = (v: unknown) =>
  v && typeof v === "object" && "display" in v ? String((v as { display: string }).display) : null;
const day = (d: unknown, tz: string) =>
  d
    ? new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(d as string))
    : null;
const moment = (d: unknown, tz: string) =>
  d
    ? new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .format(new Date(d as string))
        .replace(",", "")
    : null;

/** The screen's column ids (apps/web lib/leads/columns.ts), with the field each one shows. */
const CORE: Record<
  string,
  { header: string; field?: string; cell: Column["cell"]; contact?: Column["contact"] }
> = {
  name: { header: "Name", field: "name", cell: (v) => (v.name as string) ?? null, contact: "name" },
  stage: { header: "Stage", field: "stage", cell: (v, l) => l.stages.get(v.stageId as string) ?? null },
  owner: {
    header: "Owner",
    field: "owner",
    cell: (v, l) => (v.ownerId ? (l.people.get(v.ownerId as string) ?? null) : "Unassigned"),
  },
  phone: { header: "Phone", field: "phone", cell: (v) => display(v.phone), contact: "phone" },
  email: { header: "Email", field: "email", cell: (v) => display(v.email), contact: "email" },
  instagram: { header: "Instagram", field: "instagram", cell: (v) => display(v.instagram) },
  value: { header: "Value", field: "value", cell: (v) => (v.value == null ? null : Number(v.value)) },
  tags: {
    header: "Tags",
    cell: (v, l) =>
      v.tagIds
        .map((t) => l.tags.get(t))
        .filter(Boolean)
        .join(", ") || null,
  },
  created: {
    header: "Enquiry date",
    field: "lead_created_at",
    // The enquiry date is a calendar date, written as stored; only the arrival moment needs the business's clock.
    cell: (v, l) => (v.leadCreatedAt as string | null) ?? day(v.createdAt, l.tz),
  },
  updated: { header: "Last activity", cell: (v, l) => moment(v.lastActivityAt ?? v.updatedAt, l.tz) },
};

/**
 * The columns asked for, in the screen's order, keeping only those this person may see: a hidden field is never
 * a column, whatever the browser sends (Review Focus 1). Unknown ids are dropped; the name always leads.
 */
export function columnsFor(req: FastifyRequest, ids: string[], fields: FieldRegistry): Column[] {
  const ctx = { actor: req.actor!, fields };
  const out: Column[] = [];
  for (const id of ["name", ...ids.filter((x) => x !== "name")]) {
    if (out.some((c) => c.id === id)) continue;
    const core = CORE[id];
    if (core) {
      if (core.field && !isFieldVisible(ctx, core.field)) continue;
      out.push({
        id,
        header: core.header,
        cell: core.cell,
        ...(core.contact ? { contact: core.contact } : {}),
      });
      continue;
    }
    const key = id.startsWith("custom:") ? id.slice(7) : null;
    const def = key ? fields.byKey.get(key) : undefined;
    if (!def || def.isCore || def.archived || !isFieldVisible(ctx, def.key)) continue;
    out.push({
      id,
      header: def.label,
      cell: (v) => {
        const x = v.custom[def.key];
        // A custom contact field is masked as the core ones are, for someone who can't see contacts in full.
        if (typeof x === "string" && v.contactMasked && CONTACT_TYPES.has(def.type))
          return def.type === "phone"
            ? maskPhone({ e164: x.startsWith("+") ? x : null, raw: x })
            : def.type === "email"
              ? maskEmail(x.toLowerCase())
              : maskInstagram(x.replace(/^@/, ""));
        return x == null
          ? null
          : Array.isArray(x)
            ? x.join(", ")
            : typeof x === "object"
              ? JSON.stringify(x)
              : (x as string | number);
      },
    });
  }
  return out;
}

const CONTACT_TYPES = new Set(["phone", "email", "instagram"]);

export type Built = { header: string[]; rows: Cell[][]; leads: number };

/**
 * The view's leads as rows, read as the person (their row-level security, their masking), in the view's order.
 * Refused when there's nothing to export, or more than one file holds.
 */
export async function readView(
  req: FastifyRequest,
  q: FilterQuery & { sort: "newest" | "oldest" | "updated" | "name" },
  ids: string[],
): Promise<{ columns: Column[]; views: LeadView[]; lookups: Lookups }> {
  const fields = await loadFieldRegistry(req);
  const columns = columnsFor(req, ids, fields);
  const rows = await req.db
    .select()
    .from(schema.leads)
    .where(and(...leadFilters(req, q, fields)))
    .orderBy(...orderBy(q.sort))
    .limit(cap + 1);
  if (!rows.length)
    throw new HttpError(422, "NOTHING_TO_EXPORT", "Nothing to export: this view has no leads.");
  if (rows.length > cap)
    throw new HttpError(
      422,
      "TOO_MANY",
      `Narrow the view: up to ${cap.toLocaleString("en-US")} leads in one file.`,
    );
  const ctx = { actor: req.actor!, fields };
  const views = rows.map((r) => serializeLead(r, { ...ctx, tagIds: r.tagIds }));
  const [stages, people, tags, settings] = await Promise.all([
    req.db.select({ id: schema.stages.id, name: schema.stages.name }).from(schema.stages),
    req.db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users),
    req.db.select({ id: schema.tags.id, name: schema.tags.label }).from(schema.tags),
    req.db.select({ tz: schema.settings.timezone }).from(schema.settings),
  ]);
  return {
    columns,
    views,
    lookups: {
      stages: new Map(stages.map((s) => [s.id, s.name])),
      people: new Map(people.map((p) => [p.id, p.name])),
      tags: new Map(tags.map((t) => [t.id, t.name])),
      tz: settings[0]?.tz ?? "UTC",
    },
  };
}

/** A check row is traced by its email or its phone: a file with neither column gets none (6B review). */
export const carriesCheckRow = (columns: Column[]) =>
  columns.some((c) => c.contact === "email" || c.contact === "phone");

/**
 * The file's rows: the columns, then `LUME ref` with the code on every row, and the check row at its position
 * (none when `position` is null). The check row borrows its neighbour's other cells (stage, owner, dates) so it
 * reads like any lead.
 */
export function buildRows(
  columns: Column[],
  views: LeadView[],
  lookups: Lookups,
  mark: { code: string; check: { name: string; email: string; phone: string }; position: number | null },
): Built {
  const rows: Cell[][] = views.map((v) => [...columns.map((c) => c.cell(v, lookups)), mark.code]);
  if (mark.position === null)
    return { header: [...columns.map((c) => c.header), "LUME ref"], rows, leads: views.length };
  const near = rows[Math.min(mark.position, rows.length - 1)]!;
  const check: Cell[] = columns.map((c, i) =>
    c.contact === "name"
      ? mark.check.name
      : c.contact === "phone"
        ? formatPhone(mark.check.phone)
        : c.contact === "email"
          ? mark.check.email
          : c.id === "instagram" || c.id.startsWith("custom:") || c.id === "value"
            ? null
            : near[i]!,
  );
  rows.splice(mark.position, 0, [...check, mark.code]);
  return { header: [...columns.map((c) => c.header), "LUME ref"], rows, leads: views.length };
}

/** CSV with a byte-order mark (so Excel reads accents right); every cell made safe from formulas. */
export function toCsv(b: Built): Buffer {
  const safe = (r: Cell[]) => r.map((v) => (v === null ? "" : safeCell(v)));
  return Buffer.from(
    `\uFEFF${Papa.unparse([b.header, ...b.rows.map(safe)], { newline: "\r\n" })}\r\n`,
    "utf8",
  );
}

/** One sheet, "Leads", with a bold header; every cell made safe from formulas. */
export async function toXlsx(b: Built): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  book.creator = "LUME";
  const sheet = book.addWorksheet("Leads");
  sheet.addRow(b.header).font = { bold: true };
  for (const r of b.rows) sheet.addRow(r.map((v) => (v === null ? null : safeCell(v))));
  sheet.columns.forEach((c) => (c.width = 22));
  return Buffer.from(await book.xlsx.writeBuffer());
}
