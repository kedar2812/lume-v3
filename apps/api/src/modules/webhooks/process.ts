import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { can, type Keyring, type Mapping, type Rules } from "@lume/core";
import { schema } from "@lume/db";
import { loadActor, type ActorRecord } from "../../rbac/actor";
import { loadMapContext } from "../imports/context";
import { jobServer, withJobRequest } from "../imports/job-request";
import { writeRow } from "../imports/row";
import { givesAway, isDataError, refusalReason } from "../imports/runner";
import { createMissingTags } from "../sheets/sync";
import { cellsFor, flatten } from "./payload";

const S = schema.leadSources;
const E = schema.webhookEvents;
/** A longer value is a problem for the post, not something to write (Review Focus 4). */
const CELL_MAX = 10_000;

export type ProcessDeps = { app: FastifyInstance; pool: pg.Pool; keyring: Keyring };
export const eventContext = (sourceId: string, eventKey: string) => `webhook-event:${sourceId}:${eventKey}`;
type Problem = { column: number | null; code: string; message: string };
type Db = NodePgDatabase<typeof schema>;
type Outcome = {
  status: "done" | "error";
  result: "created" | "merged" | "skipped" | null;
  leadId: string | null;
  problems: Problem[];
};
const finish = (db: Db, eventId: number, r: Outcome) =>
  db
    .update(E)
    .set({
      status: r.status,
      result: r.result,
      leadId: r.leadId,
      problems: r.problems,
      processedAt: new Date(),
    })
    .where(eq(E.id, eventId));
const problem = (column: number | null, code: string, message: string): Outcome => ({
  status: "error",
  result: null,
  leadId: null,
  problems: [{ column, code, message }],
});

/** The person the webhook runs as, if they may still do what its rules do (as a sheet, 2B A2). */
async function runAsActor(o: ProcessDeps, runAs: string | null, rules: Rules, mapping: Mapping) {
  const actor = runAs ? await loadActor(o.pool, runAs) : null;
  if (
    actor &&
    can(actor, "leads.import") &&
    (!givesAway(rules, mapping, actor) || can(actor, "leads.assign"))
  )
    return { actor };
  const { rows } = runAs
    ? await o.pool.query<{ name: string }>("SELECT name FROM users WHERE id = $1", [runAs])
    : { rows: [] };
  return {
    refused: `${rows[0]?.name ?? "The person who set up this webhook"} set up this webhook and can no longer add leads. Open the webhook's settings and save them to run it as you.`,
  };
}

/**
 * 2C spec §5: one accepted post, through the same engine as an import. Safe to call twice: the event is
 * locked and re-checked in the transaction that writes its lead. A data error is the post's problem; any
 * other failure throws, and the queue tries again.
 */
export async function processEvent(o: ProcessDeps, eventId: number): Promise<void> {
  o = { ...o, app: jobServer(o.app) };
  const db = drizzle(o.pool, { schema }); // the intake tables have no row-level security (2A amendment 5)
  const [ev] = await db.select().from(E).where(eq(E.id, eventId));
  if (!ev || (ev.status !== "queued" && ev.status !== "error") || !ev.payloadEnc) return;
  const [src] = await db.select().from(S).where(eq(S.id, ev.sourceId));
  // A paused or removed webhook keeps its posts queued; they go through when it's back.
  if (!src || src.type !== "webhook" || (src.status !== "active" && src.status !== "needs_attention")) return;
  const rules = src.rules as Rules;
  const mapping = src.mapping as Mapping;

  const who = await runAsActor(o, src.runAs, rules, mapping);
  if (!("actor" in who)) {
    await db
      .update(S)
      .set({ status: "needs_attention", attentionCode: "RUN_AS_ACCESS", lastError: who.refused })
      .where(eq(S.id, src.id));
    return; // the post stays queued
  }
  const actor: ActorRecord = who.actor!;
  if (src.status === "needs_attention" && src.attentionCode === "RUN_AS_ACCESS")
    await db
      .update(S)
      .set({ status: "active", attentionCode: null, lastError: null })
      .where(eq(S.id, src.id));

  const payload = JSON.parse(o.keyring.decrypt(ev.payloadEnc, eventContext(src.id, ev.eventKey))) as Record<
    string,
    unknown
  >;
  const { cells } = flatten(payload);
  const headers = src.headers as string[];
  const unknown = [...cells.keys()].filter((p) => !headers.includes(p));
  const known = (src.newColumns as string[] | null) ?? [];
  const fresh = unknown.filter((p) => !known.includes(p));
  if (fresh.length)
    await db
      .update(S)
      .set({ newColumns: [...known, ...fresh] })
      .where(eq(S.id, src.id));

  const row = cellsFor(headers, cells);
  const job = (suffix: string) => ({
    app: o.app,
    pool: o.pool,
    actor,
    requestId: `webhook:${eventId}:${suffix}`,
    allLeads: true,
  });
  const long = row.findIndex((c) => c.length > CELL_MAX);
  if (long >= 0)
    return void (await finish(
      db,
      eventId,
      problem(long, "CELL_TOO_LONG", "A value is over 10,000 characters."),
    ));

  try {
    if (mapping.createMissingTags)
      await withJobRequest(job("tags"), (req) => createMissingTags(req, mapping, [row]));
    const ctx = await withJobRequest(job("context"), (req) =>
      loadMapContext(req, {
        pipelineId: rules.pipelineId,
        headerCount: headers.length,
        columnSettings: src.columnSettings as never,
      }),
    );
    await withJobRequest(job("row"), async (req) => {
      // Locked for this transaction: a retry and the queue can't both write this post's lead.
      const { rows } = await req.db.execute<{ status: string }>(
        sql`SELECT status FROM webhook_events WHERE id = ${eventId} FOR UPDATE`,
      );
      if (rows[0]?.status !== "queued" && rows[0]?.status !== "error") return;
      const r = await writeRow(req, {
        sourceId: src.id,
        rules,
        mapping,
        ctx,
        cells: row,
        origin: { sourceId: src.id, webhook: src.name, event: eventId },
        nextTurn: async () => {
          const { rows: t } = await req.db.execute<{ n: number }>(
            sql`UPDATE lead_sources SET rr_cursor = rr_cursor + 1 WHERE id = ${src.id} RETURNING rr_cursor - 1 AS n`,
          );
          return Number(t[0]!.n);
        },
      });
      await finish(req.db, eventId, {
        status: r.result === "error" ? "error" : "done",
        result: r.result === "error" ? null : r.result,
        leadId: r.leadId,
        problems: r.problems,
      });
    });
  } catch (e) {
    if (!isDataError(e)) throw e;
    await finish(
      db,
      eventId,
      problem(null, "ROW_NOT_SAVED", `LUME couldn't save this post (${refusalReason(e)}).`),
    );
  }
}
