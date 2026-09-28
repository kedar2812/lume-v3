import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import {
  can,
  fieldAccessOf,
  type DateOrder,
  type IntakeField,
  type LeadDraft,
  type MapContext,
  type Mapping,
  type Rules,
} from "@lume/core";
import { contactKeyHash, schema } from "@lume/db";

type Kind = "phone" | "email" | "instagram";

const todayIn = (tz: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

export type FullMapContext = MapContext & {
  stagesFull: {
    id: string;
    name: string;
    kind: "open" | "won" | "lost";
    requiredFieldIds: string[];
    onEnter: unknown;
  }[];
};

/**
 * Everything a row is checked against, for this importer, now. `pending` adds the options chosen to be
 * created at Start, so the preview treats them as real.
 */
export async function loadMapContext(
  req: FastifyRequest,
  o: {
    pipelineId: string;
    headerCount: number;
    columnSettings?: { dateOrders: Record<number, DateOrder>; decimalMarks: Record<number, "." | ","> };
    pending?: Mapping;
  },
): Promise<FullMapContext> {
  const actor = req.actor!;
  const [settings] = await req.db.select().from(schema.settings).where(eq(schema.settings.id, 1));
  const defs = await req.db
    .select()
    .from(schema.fieldDefinitions)
    .orderBy(asc(schema.fieldDefinitions.position));
  const stagesFull = await req.db
    .select({
      id: schema.stages.id,
      name: schema.stages.name,
      kind: schema.stages.kind,
      requiredFieldIds: schema.stages.requiredFieldIds,
      onEnter: schema.stages.onEnter, // what a new lead's first stage does (3C)
    })
    .from(schema.stages)
    .where(and(eq(schema.stages.pipelineId, o.pipelineId), isNull(schema.stages.archivedAt)))
    .orderBy(asc(schema.stages.position));
  const people = await req.db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      status: schema.users.status,
    })
    .from(schema.users);
  const tags = await req.db.select({ id: schema.tags.id, label: schema.tags.label }).from(schema.tags);
  const reasons = await req.db
    .select({ id: schema.lostReasons.id, label: schema.lostReasons.label })
    .from(schema.lostReasons)
    .where(isNull(schema.lostReasons.archivedAt));
  const fields: IntakeField[] = defs.map((f) => {
    const extra = o.pending?.addOptions?.[f.key] ?? [];
    return {
      id: f.id,
      key: f.key,
      label: f.label,
      type: f.type,
      isCore: f.isCore,
      isRequired: f.isRequired,
      archived: f.archivedAt !== null,
      access: fieldAccessOf(actor.fieldAccess, f.id),
      options: [
        ...f.options.map((x) => ({ id: x.id, label: x.label, archived: x.archived })),
        ...extra.map((label) => ({ id: `new:${label}`, label })),
      ],
    };
  });
  return {
    fields,
    stages: stagesFull.map(({ id, name, kind }) => ({ id, name, kind })),
    stagesFull,
    people: people.map((p) => ({ id: p.id, name: p.name, email: p.email, active: p.status === "active" })),
    tags,
    lostReasons: reasons,
    currency: settings!.currency,
    country: settings!.defaultCountryIso,
    today: todayIn(settings!.timezone),
    timezone: settings!.timezone,
    importerId: actor.userId,
    canAssign: can(actor, "leads.assign"),
    canManageFields: can(actor, "fields.manage"),
    canManageTags: can(actor, "settings.manage"),
    headerCount: o.headerCount,
    dateOrders: o.columnSettings?.dateOrders ?? {},
    decimalMarks: o.columnSettings?.decimalMarks ?? {},
  };
}

/** The contact keys a draft would be matched on, in the rules' order (spec §6.9). */
export function contactProbes(draft: LeadDraft, matchOn: Rules["matchOn"]): { kind: Kind; hash: string }[] {
  return matchOn.flatMap<{ kind: Kind; hash: string }>((kind) => {
    if (kind === "phone" && draft.phone.status === "valid" && draft.phone.e164)
      return [{ kind, hash: contactKeyHash("phone", draft.phone.e164) }];
    if (kind === "email" && draft.email)
      return [{ kind, hash: contactKeyHash("email", draft.email.toLowerCase()) }];
    if (kind === "instagram" && draft.instagram)
      return [{ kind, hash: contactKeyHash("instagram", draft.instagram.toLowerCase()) }];
    return [];
  });
}

/**
 * Existing leads sharing a contact with the draft (spec §6.9 steps 1, 3, 5), best first: by the rules'
 * order of contacts, then most recently active. Deleted leads never match. Run inside a lead_scope 'all'
 * transaction (withJobRequest), so every lead is considered, whoever the importer is.
 */
export async function findMatches(
  req: FastifyRequest,
  draft: LeadDraft,
  matchOn: Rules["matchOn"],
): Promise<{ leadId: string; kind: Kind }[]> {
  const probes = contactProbes(draft, matchOn);
  if (!probes.length) return [];
  const K = schema.leadContactKeys;
  const rows = await req.db
    .select({ leadId: K.leadId, kind: K.kind, active: schema.leads.lastActivityAt })
    .from(K)
    .innerJoin(schema.leads, and(eq(schema.leads.id, K.leadId), isNull(schema.leads.deletedAt)))
    .where(or(...probes.map((p) => and(eq(K.kind, p.kind), eq(K.keyHash, p.hash)))))
    .orderBy(desc(schema.leads.lastActivityAt));
  const rank = (k: Kind) => matchOn.indexOf(k);
  const seen = new Set<string>();
  return rows
    .sort((a, b) => rank(a.kind) - rank(b.kind) || (b.active?.getTime() ?? 0) - (a.active?.getTime() ?? 0))
    .filter((r) => !seen.has(r.leadId) && seen.add(r.leadId))
    .map((r) => ({ leadId: r.leadId, kind: r.kind }));
}
