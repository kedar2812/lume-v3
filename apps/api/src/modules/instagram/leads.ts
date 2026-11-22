import { maskInstagram, normalizeInstagram, type Rules } from "@lume/core";
import { schema } from "@lume/db";
import { and, asc, eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { insertLead } from "../leads/writer";

/** An account as its jobs read it. */
export type IgAccountRow = {
  id: string;
  igUserId: string;
  username: string;
  ownerUserId: string | null;
  sourceId: string | null;
  newDmCreatesLead: boolean;
};

const HANDLE = /^[a-z0-9._]{1,30}$/;
/** A lead's name when LUME knows nothing of the person yet (Meta didn't answer); replaced once their name is read. */
export const INSTAGRAM_LEAD_NAME = "Instagram lead";
/** A username as LUME keeps Instagram handles (lower case, no @), or null when it isn't one. */
export const handleOf = (username: string | null | undefined): string | null => {
  if (!username) return null;
  const h = normalizeInstagram(username);
  return HANDLE.test(h) ? h : null;
};

/**
 * A lead whose Instagram handle is this username (a lead that came from ManyChat, a sheet or a form): the account
 * owner's own first, then the most recently active. Runs with every lead in scope. Null: no such lead.
 */
export async function leadByHandle(
  req: FastifyRequest,
  username: string | null,
  ownerUserId: string | null,
): Promise<string | null> {
  const h = handleOf(username);
  if (!h) return null;
  const r = await req.db.execute<{ id: string }>(sql`
    SELECT id FROM leads
     WHERE instagram_handle = ${h} AND deleted_at IS NULL
     ORDER BY (${ownerUserId}::uuid IS NOT NULL AND owner_id = ${ownerUserId}::uuid) DESC,
              coalesce(last_activity_at, created_at) DESC, created_at DESC
     LIMIT 1`);
  return r.rows[0]?.id ?? null;
}

/** Whether a lead is still there (not deleted) for a conversation to stay on. */
export async function liveLead(req: FastifyRequest, leadId: string | null): Promise<string | null> {
  if (!leadId) return null;
  const r = await req.db.execute(sql`SELECT 1 FROM leads WHERE id = ${leadId} AND deleted_at IS NULL`);
  return r.rows.length ? leadId : null;
}

type Where = { pipelineId: string; stageId: string; kind: "open" | "won" | "lost" };

/** The source's pipeline and stage while they're live, else the default pipeline's first open stage. */
async function whereTo(req: FastifyRequest, rules: Partial<Rules> | null): Promise<Where | null> {
  if (rules?.pipelineId && rules.stageId) {
    const [s] = await req.db
      .select({ id: schema.stages.id, kind: schema.stages.kind })
      .from(schema.stages)
      .innerJoin(schema.pipelines, eq(schema.pipelines.id, schema.stages.pipelineId))
      .where(
        and(
          eq(schema.stages.id, rules.stageId),
          eq(schema.stages.pipelineId, rules.pipelineId),
          sql`${schema.stages.archivedAt} IS NULL`,
          sql`${schema.pipelines.archivedAt} IS NULL`,
        ),
      );
    if (s) return { pipelineId: rules.pipelineId, stageId: s.id, kind: s.kind as Where["kind"] };
  }
  const [p] = await req.db
    .select({ id: schema.pipelines.id })
    .from(schema.pipelines)
    .where(and(eq(schema.pipelines.isDefault, true), sql`${schema.pipelines.archivedAt} IS NULL`));
  if (!p) return null;
  const [s] = await req.db
    .select({ id: schema.stages.id })
    .from(schema.stages)
    .where(
      and(
        eq(schema.stages.pipelineId, p.id),
        eq(schema.stages.kind, "open"),
        sql`${schema.stages.archivedAt} IS NULL`,
      ),
    )
    .orderBy(asc(schema.stages.position))
    .limit(1);
  return s ? { pipelineId: p.id, stageId: s.id, kind: "open" } : null;
}

/**
 * Who a new lead goes to: the source's chosen person while they can take leads, or the next in its round robin; with
 * neither ("unassigned"), the account's owner when it's a person's own account, else nobody.
 */
async function ownerFor(req: FastifyRequest, account: IgAccountRow, rules: Partial<Rules> | null) {
  const active = async (ids: string[]) =>
    (
      await req.db.execute<{ id: string; name: string }>(sql`
        SELECT id, name FROM users WHERE status = 'active' AND id = ANY(${`{${ids.join(",")}}`}::uuid[])`)
    ).rows;
  const o = rules?.owner;
  if (o?.mode === "user") {
    const [u] = await active([o.userId]);
    if (u) return u.id;
  } else if (o?.mode === "round_robin" && o.userIds.length && account.sourceId) {
    const turns = (await active(o.userIds)).sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
    if (turns.length) {
      const next = await req.db.execute<{ n: number }>(
        sql`UPDATE lead_sources SET rr_cursor = rr_cursor + 1 WHERE id = ${account.sourceId} RETURNING rr_cursor - 1 AS n`,
      );
      return turns[Number(next.rows[0]?.n ?? 0) % turns.length]!.id;
    }
  }
  if (account.ownerUserId) {
    const [u] = await active([account.ownerUserId]);
    if (u) return u.id;
  }
  return null;
}

/**
 * A new lead for an Instagram person (NEW_FEATURES_PLAN §4.3), through the one path that creates leads: under the
 * account's lead source, at its stage, with its owner rule, named as the person is on Instagram. Null when LUME has no
 * pipeline with an open stage to put it in.
 */
export async function createInstagramLead(
  req: FastifyRequest,
  account: IgAccountRow,
  p: {
    username: string | null;
    name: string | null;
    adId: string | null;
    how: string;
    /** Whose lead it is, when a person's own action makes it (they answered the comment); else the source's rule. */
    ownerId?: string;
  },
): Promise<string | null> {
  const [src] = account.sourceId
    ? await req.db
        .select({ rules: schema.leadSources.rules })
        .from(schema.leadSources)
        .where(eq(schema.leadSources.id, account.sourceId))
    : [];
  const rules = (src?.rules ?? null) as Partial<Rules> | null;
  const where = await whereTo(req, rules);
  if (!where) return null;
  const handle = handleOf(p.username);
  // A name made from the handle is a contact shown to everyone who sees the lead: masked, as intake masks one (C1).
  const name = p.name?.trim().slice(0, 200) || (handle ? maskInstagram(handle) : INSTAGRAM_LEAD_NAME);
  const id = await insertLead(req, {
    pipelineId: where.pipelineId,
    stageId: where.stageId,
    ownerId: p.ownerId ?? (await ownerFor(req, account, rules)),
    name,
    contact: {
      phoneRaw: null,
      phoneE164: null,
      phoneCountryIso: null,
      phoneStatus: "missing",
      email: null,
      instagramHandle: handle,
    },
    value: null,
    productId: null,
    leadCreatedAt: null,
    custom: {},
    tagIds: [],
    sourceId: account.sourceId,
    lostReasonId: null,
    closedAt: null,
    stageKind: where.kind,
    stageEnteredAt: new Date(),
    activity: { type: "lead_created", payload: { source: "instagram", accountId: account.id, how: p.how } },
    assignReason: "created",
  });
  if (p.adId)
    await req.db.execute(sql`UPDATE leads SET ad_id = ${p.adId} WHERE id = ${id} AND ad_id IS NULL`);
  return id;
}
