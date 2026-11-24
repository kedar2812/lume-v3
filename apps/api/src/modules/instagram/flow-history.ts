import { matchKeyword, toGraph, type FlowGraph, type FlowStep, type KeywordMode } from "@lume/core";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { audit } from "../../audit/audit";
import { conflict, notFound } from "../../http/errors";
import { visibleLead } from "../leads/service";
import { photosFor, photoUrl } from "./photos-of";
import { flowView, requireFlows } from "./flow-admin";
import { pgArray } from "./flow-run";
import { withAllScope } from "./service";

/**
 * A flow's history and its tools (plan 2026-11-23-flow-builder, Task A3): its versions and what changed in each, a
 * version brought back as the draft, one lead's way through it (Replay), and the keyword tester.
 */

/** Versions listed at a time: the newest. */
export const VERSIONS_SHOWN = 50;

/** What changed from one version to the next, by step id (where a step sits on the canvas isn't a change). */
export function changesBetween(
  before: FlowStep[] | FlowGraph | null,
  after: FlowStep[] | FlowGraph,
): { added: number; removed: number; changed: number } {
  const was = new Map((before ? toGraph(before).nodes : []).map((n) => [n.id, JSON.stringify(n)]));
  const now = new Map(toGraph(after).nodes.map((n) => [n.id, JSON.stringify(n)]));
  let added = 0;
  let changed = 0;
  for (const [id, json] of now) {
    const old = was.get(id);
    if (old === undefined) added++;
    else if (old !== json) changed++;
  }
  let removed = 0;
  for (const id of was.keys()) if (!now.has(id)) removed++;
  return { added, removed, changed };
}

export async function flowVersions(req: FastifyRequest, flowId: string) {
  await requireFlows(req);
  const f = await req.db.execute<{ live_version_id: string | null }>(
    sql`SELECT live_version_id FROM instagram_flows WHERE id = ${flowId}`,
  );
  if (!f.rows[0]) throw notFound("FLOW_NOT_FOUND", "That flow isn't in LUME any more.");
  // One more than shown: the oldest shown is compared with the one before it.
  const r = await req.db.execute<{
    id: string;
    version: number;
    steps: FlowStep[] | FlowGraph;
    created_at: Date;
    by_id: string | null;
    by_name: string | null;
  }>(sql`
    SELECT v.id, v.version, v.steps, v.created_at, u.id AS by_id, u.name AS by_name
      FROM instagram_flow_versions v LEFT JOIN users u ON u.id = v.created_by
     WHERE v.flow_id = ${flowId}
     ORDER BY v.version DESC LIMIT ${VERSIONS_SHOWN + 1}`);
  const rows = r.rows;
  return {
    versions: rows.slice(0, VERSIONS_SHOWN).map((v, i) => ({
      id: v.id,
      version: v.version,
      createdAt: v.created_at,
      createdBy: v.by_id ? { id: v.by_id, name: v.by_name } : null,
      live: v.id === f.rows[0]!.live_version_id,
      changes: changesBetween(rows[i + 1]?.steps ?? null, v.steps),
    })),
  };
}

/** A version back as the draft (to look at, change, publish again); what's live doesn't change until then. */
export async function restoreVersion(
  req: FastifyRequest,
  flowId: string,
  versionId: string,
  body: { rev: number },
) {
  await requireFlows(req);
  const f = (
    await req.db.execute<{ status: string; rev: number }>(
      sql`SELECT status, rev FROM instagram_flows WHERE id = ${flowId} FOR UPDATE`,
    )
  ).rows[0];
  if (!f) throw notFound("FLOW_NOT_FOUND", "That flow isn't in LUME any more.");
  if (f.status === "archived")
    throw conflict("FLOW_ARCHIVED", "This flow is archived. Duplicate it to use it again.");
  if (f.rev !== body.rev)
    throw conflict("FLOW_CHANGED", "Someone else changed this flow meanwhile. Reload to see their changes.");
  const v = (
    await req.db.execute<{ version: number; steps: unknown }>(
      sql`SELECT version, steps FROM instagram_flow_versions WHERE id = ${versionId} AND flow_id = ${flowId}`,
    )
  ).rows[0];
  if (!v) throw notFound("VERSION_NOT_FOUND", "That version isn't in LUME any more.");
  await req.db.execute(sql`
    UPDATE instagram_flows SET draft_steps = ${JSON.stringify(v.steps)}::jsonb, rev = rev + 1, updated_at = now()
     WHERE id = ${flowId}`);
  await audit(req, {
    action: "instagram.flow.restored",
    entityType: "instagram_flow",
    entityId: flowId,
    diff: { version: v.version },
  });
  return flowView(req, flowId);
}

type RunRow = {
  id: string;
  status: string;
  reason: string | null;
  version: number;
  created_at: Date;
  next_at: Date | null;
  state: {
    at: string | null;
    waiting: null | { for: string; stepId?: string; nodeId?: string; until?: string };
    sent?: number;
  };
};

/** Runs shown for one lead: the newest. */
export const RUNS_SHOWN = 20;

/**
 * Replay: one lead's runs through this flow, newest first, each with the steps it went through and where it waits.
 * Only for a lead the asker may see (a lead they can't see answers as not found).
 */
export async function leadRuns(req: FastifyRequest, flowId: string, leadId: string) {
  await requireFlows(req);
  await visibleLead(req, leadId);
  return withAllScope(req, async () => {
    const runs = await req.db.execute<RunRow>(sql`
      SELECT r.id, r.status, r.reason, v.version, r.created_at, r.next_at, r.state
        FROM instagram_flow_runs r JOIN instagram_flow_versions v ON v.id = r.version_id
       WHERE r.flow_id = ${flowId} AND r.lead_id = ${leadId}
       ORDER BY r.created_at DESC LIMIT ${RUNS_SHOWN}`);
    const ids = runs.rows.map((r) => r.id);
    const trail = ids.length
      ? await req.db.execute<{ run_id: string; step: string; at: Date }>(sql`
          SELECT run_id, split_part(step_key, ':', 1) AS step, at FROM instagram_flow_events
           WHERE run_id = ANY(${pgArray(ids)}::uuid[]) AND kind = 'entered'
           ORDER BY id`)
      : { rows: [] };
    return {
      runs: runs.rows.map((r) => {
        const w = r.state.waiting;
        const waiting =
          (r.status === "waiting" || r.status === "running") && w
            ? {
                // A Wait: the step it waits in is the last it entered (state.at is the one after it).
                step:
                  w.nodeId ??
                  w.stepId ??
                  (w.for === "until"
                    ? (trail.rows.filter((t) => t.run_id === r.id).at(-1)?.step ?? r.state.at)
                    : r.state.at),
                why: (w.for === "reply"
                  ? "reply"
                  : w.for === "answer"
                    ? "answer"
                    : w.for === "until"
                      ? "time"
                      : "message") as "reply" | "answer" | "time" | "message",
                until: r.next_at,
              }
            : null;
        return {
          id: r.id,
          status: r.status,
          reason: r.reason,
          version: r.version,
          startedAt: r.created_at,
          sent: r.state.sent ?? 0,
          trail: trail.rows.filter((t) => t.run_id === r.id).map((t) => ({ step: t.step, at: t.at })),
          waiting,
        };
      }),
    };
  });
}

/** People listed for Replay at a time, and the runs read to find them (newest first). */
export const PEOPLE_SHOWN = 20;
export const PEOPLE_READ = 5_000;

/**
 * Replay's list: who went through this flow lately, newest first, each once, with how their latest run stands.
 * Bounded whatever the flow's size or the asker's reach (review 2026-11-24): the newest PEOPLE_READ runs are read for
 * their leads alone (ids, when, how it stands: nothing about the person), one per lead, so a lead with hundreds of runs
 * hides nobody; then names are read under the asker's own row security, so only leads they may see (and not deleted)
 * are listed, and a search reads those names (case aside). A flow far busier than PEOPLE_READ lists its recent people.
 */
export async function flowPeople(req: FastifyRequest, flowId: string, q: string | undefined) {
  await requireFlows(req);
  const words = q?.trim() ?? "";
  const recent = await withAllScope(req, () =>
    req.db.execute<{ lead_id: string; started: Date; status: string }>(sql`
      SELECT DISTINCT ON (x.lead_id) x.lead_id, x.created_at AS started, x.status
        FROM (SELECT lead_id, created_at, status FROM instagram_flow_runs WHERE flow_id = ${flowId}
               ORDER BY created_at DESC LIMIT ${PEOPLE_READ}) x
       ORDER BY x.lead_id, x.created_at DESC`),
  );
  const ids = recent.rows.map((x) => x.lead_id);
  const named = ids.length
    ? await req.db.execute<{ id: string; name: string }>(sql`
        SELECT id, name FROM leads WHERE id = ANY(${pgArray(ids)}::uuid[]) AND deleted_at IS NULL
          ${words ? sql`AND strpos(lower(name), lower(${words})) > 0` : sql``}`)
    : { rows: [] };
  const nameOf = new Map(named.rows.map((x) => [x.id, x.name]));
  const rows = recent.rows
    .filter((x) => nameOf.has(x.lead_id))
    .sort((a, b) => new Date(b.started).getTime() - new Date(a.started).getTime())
    .slice(0, PEOPLE_SHOWN)
    .map((x) => ({ ...x, name: nameOf.get(x.lead_id)! }));
  const photos = await photosFor(
    req,
    rows.map((x) => x.lead_id),
  );
  return {
    people: rows.map((x) => {
      const p = photos.get(x.lead_id);
      return {
        leadId: x.lead_id,
        name: x.name,
        photo: p ? photoUrl(x.lead_id, p) : null,
        startedAt: x.started,
        status: x.status,
      };
    }),
  };
}

/**
 * The keyword tester: would these words start this flow, and which other live or paused flows would they start too
 * (the one with the higher priority answers; the builder says so before it's a surprise).
 */
export async function testKeyword(
  req: FastifyRequest,
  body: { text: string; keywords: string[]; mode: KeywordMode; flowId?: string },
) {
  await requireFlows(req);
  const keyword = matchKeyword(body.text, body.keywords, body.mode);
  const others = await req.db.execute<{
    flow_id: string;
    name: string;
    keywords: string[];
    mode: KeywordMode;
  }>(sql`
    SELECT t.flow_id, f.name, t.keywords, t.mode FROM instagram_triggers t JOIN instagram_flows f ON f.id = t.flow_id
     WHERE t.enabled AND f.status IN ('live', 'paused') AND t.kind IN ('comment', 'dm')
       ${body.flowId ? sql`AND f.id <> ${body.flowId}` : sql``}
     ORDER BY f.priority DESC, f.created_at`);
  const overlaps: { flowId: string; name: string; keyword: string }[] = [];
  for (const t of others.rows) {
    const k = matchKeyword(body.text, t.keywords, t.mode);
    if (k !== null && !overlaps.some((o) => o.flowId === t.flow_id))
      overlaps.push({ flowId: t.flow_id, name: t.name, keyword: k || "Any message" });
  }
  return { starts: keyword !== null, keyword: keyword === "" ? null : keyword, overlaps };
}
