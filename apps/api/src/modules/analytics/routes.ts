import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { METRICS, type MetricId } from "@lume/core";
import type { AppDeps } from "../../app";
import { badRequest, notFound } from "../../http/errors";
import { listLeads } from "../leads/query";
import { drillFor, drillIds, readDrill } from "./drill";
import { listGoals, removeGoal, setGoal, setSpend } from "./goals";
import { CSV_MODULES, boardCsv } from "./csv";
import { insights } from "./insights";
import { me } from "./me";
import { revenue } from "./revenue";
import { segments } from "./segments";
import { lost, quality, sources, templates, timing } from "./modules";
import { funnel } from "./funnel";
import { glance } from "./glance";
import { recountNow } from "./rollup";
import { businessTz, overview, rangeOf, type AnalyticsQuery } from "./service";
import { team } from "./team";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const uuidList = (max: number) =>
  z
    .string()
    .regex(new RegExp(`^${UUID}(,${UUID}){0,${max - 1}}$`, "i"))
    .transform((v) => v.toLowerCase().split(","));
const fieldsSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  z.array(z.string().min(1).max(100)).min(1).max(10),
);
const query = z
  .object({
    range: z
      .enum(["today", "yesterday", "7d", "30d", "90d", "this_month", "last_month", "this_quarter", "custom"])
      .default("30d"),
    from: day.optional(),
    to: day.optional(),
    compare: z.enum(["0", "1"]).default("1"),
    pipeline: z.uuid().optional(),
    // Several people (or "none": leads nobody owns), a team, several sources (8D spec §4 Filters).
    owner: z.union([z.literal("none").transform(() => ["none"]), uuidList(50)]).optional(),
    team: z.uuid().optional(),
    source: uuidList(20).optional(),
    // Live-only (8D-1 Task 3): any of these tags; custom fields as JSON {key: [values]}.
    tag: uuidList(10).optional(),
    fields: z.string().max(2000).optional(),
    // The funnel, split by where leads came from or who had them (8D-1 Task 4).
    split: z.enum(["source", "owner"]).optional(),
    // What converts, by this field (8D-1 Task 6).
    field: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/)
      .optional(),
  })
  .refine((q) => q.range !== "custom" || (q.from && q.to), "A custom range needs from and to");

type Raw = z.infer<typeof query>;
/** The query as the modules take it: a team becomes its people (with any people named, those of them in it). */
async function toQuery(req: FastifyRequest, q: Raw): Promise<AnalyticsQuery> {
  let ownerIds = q.owner;
  if (q.team) {
    // As the API's owner of teams: whether someone may see that team's numbers is reachOf's call, per person.
    const t = await req.db.execute<{ user_id: string | null }>(sql`
      SELECT m.user_id FROM teams t LEFT JOIN team_members m ON m.team_id = t.id
      WHERE t.id = ${q.team}::uuid AND t.deleted_at IS NULL`);
    if (!t.rows.length) throw notFound("TEAM_NOT_FOUND", "That team doesn't exist.");
    const members = t.rows.flatMap((r) => (r.user_id ? [r.user_id] : []));
    ownerIds = ownerIds ? ownerIds.filter((id) => members.includes(id)) : members;
    // A team with nobody in it (or none of the people named): nobody's numbers, not everyone's.
    if (!ownerIds.length) ownerIds = ["00000000-0000-0000-0000-000000000000"];
  }
  let fields: Record<string, string[]> | undefined;
  if (q.fields) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(q.fields);
    } catch {
      throw badRequest("BAD_FILTER", "fields must be a JSON object of field keys and values");
    }
    const ok = fieldsSchema.safeParse(parsed);
    if (!ok.success || Object.keys(ok.data).length > 3)
      throw badRequest("BAD_FILTER", "fields: up to 3 fields, each with up to 10 values");
    fields = ok.data;
  }
  return {
    range: q.range,
    ...(q.from ? { from: q.from } : {}),
    ...(q.to ? { to: q.to } : {}),
    compare: q.compare === "1",
    ...(q.pipeline ? { pipelineId: q.pipeline } : {}),
    ...(ownerIds?.length ? { ownerIds } : {}),
    ...(q.team && !q.owner ? { teamId: q.team } : {}),
    ...(q.source?.length ? { sourceIds: q.source } : {}),
    ...(q.tag?.length ? { tagIds: q.tag } : {}),
    ...(fields ? { fields } : {}),
  };
}

/**
 * Analytics (8A, spec §5.2), for anyone with analytics.view, at their reach. Each module answers with its numbers and,
 * for every number with leads behind it, a drill-down token valid for 15 minutes.
 */
export async function analyticsRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const view = { permission: "analytics.view" as const };

  r.get("/api/v1/analytics/overview", { config: view, schema: { querystring: query } }, async (req) => {
    const q = await toQuery(req, req.query);
    const now = d.clock();
    const body = await overview(req, q, now);
    const tz = await businessTz(req);
    const range = rangeOf(q, tz, now);
    const drill: Partial<Record<MetricId, string>> = {};
    for (const t of body.tiles)
      if (METRICS[t.id].drill) drill[t.id] = drillFor(d, req, range, q, tz, t.id, undefined, now);
    return { ...body, drill };
  });
  r.get("/api/v1/analytics/funnel", { config: view, schema: { querystring: query } }, async (req) =>
    funnel(
      req,
      { ...(await toQuery(req, req.query)), ...(req.query.split ? { split: req.query.split } : {}) },
      d.clock(),
      d,
    ),
  );
  r.get("/api/v1/analytics/team", { config: view, schema: { querystring: query } }, async (req) =>
    team(req, await toQuery(req, req.query), d.clock(), d),
  );

  // Modules that carry drill tokens take the keyring; the rest ignore it.
  const reads: Record<
    string,
    (req: FastifyRequest, q: AnalyticsQuery, now: Date, deps: AppDeps) => Promise<unknown>
  > = { sources, lost, timing, templates, quality, revenue };
  for (const [name, read] of Object.entries(reads))
    r.get(`/api/v1/analytics/${name}`, { config: view, schema: { querystring: query } }, async (req) =>
      read(req, await toQuery(req, req.query), d.clock(), d),
    );
  // A board's numbers as CSV (8D-1 Task 12): numbers and labels only. Seeing the board is the gate; exporting
  // also needs leads.export, refused in its own words.
  for (const m of CSV_MODULES)
    r.get(
      `/api/v1/analytics/${m}/csv`,
      { config: view, schema: { querystring: query } },
      async (req, reply) => boardCsv(req, reply, d, m, await toQuery(req, req.query)),
    );
  // A rep's own view (8D-1 Task 10): always the viewer's own numbers.
  // Analytics' Refresh (owner, 2026-10-05): recount today, yesterday and any changed past days now, on the job
  // connections; at most once a minute for the whole business.
  r.post("/api/v1/analytics/refresh", { config: view }, async () =>
    recountNow(d.jobPool ?? d.pool, d.clock()),
  );
  // Today's quick stats: four numbers with trends and sparklines, at the viewer's reach.
  r.get("/api/v1/analytics/glance", { config: view }, async (req) => glance(req, d.clock()));
  r.get("/api/v1/analytics/me", { config: view, schema: { querystring: query } }, async (req) =>
    me(req, await toQuery(req, req.query), d.clock(), d),
  );
  r.get("/api/v1/analytics/segments", { config: view, schema: { querystring: query } }, async (req) =>
    segments(req, await toQuery(req, req.query), req.query.field, d.clock(), d),
  );
  r.get("/api/v1/analytics/insights", { config: view, schema: { querystring: query } }, async (req) =>
    insights(req, await toQuery(req, req.query), d.clock()),
  );

  // Goals (8B): set by admins; seen by everyone within their reach, with progress and pace.
  const goalBody = z
    .object({
      scope: z.enum(["user", "team", "business"]),
      scopeId: z.uuid().nullable(),
      metric: z.enum(["won", "revenue", "calls_held", "new_leads", "ontime"]),
      period: z.enum(["month", "quarter"]),
      periodStart: day,
      target: z.number().positive().max(1e12),
    })
    .strict();
  r.get(
    "/api/v1/analytics/goals",
    {
      config: view,
      schema: {
        querystring: z.object({ period: z.enum(["month", "quarter"]).default("month"), start: day }),
      },
    },
    (req) => listGoals(req, req.query.start, req.query.period, d.clock()),
  );
  r.put(
    "/api/v1/analytics/goals",
    { config: { permission: "settings.manage" }, schema: { body: goalBody } },
    (req) => setGoal(req, req.body),
  );
  r.delete(
    "/api/v1/analytics/goals/:id",
    { config: { permission: "settings.manage" }, schema: { params: z.object({ id: z.uuid() }) } },
    async (req, reply) => {
      await removeGoal(req, req.params.id);
      return reply.code(204).send();
    },
  );
  r.put(
    "/api/v1/settings/sources/:id/spend",
    {
      config: { permission: "settings.manage" },
      schema: {
        params: z.object({ id: z.uuid() }),
        body: z.object({ monthlySpend: z.number().min(0).max(1e12).nullable() }).strict(),
      },
    },
    (req) => setSpend(req, req.params.id, req.body.monthlySpend),
  );

  r.get(
    "/api/v1/analytics/drilldown",
    {
      config: view,
      schema: {
        // In the query, not the path: a sealed token is longer than a path segment may be.
        querystring: z.object({
          token: z.string().min(16).max(4000),
          cursor: z.string().max(400).optional(),
        }),
      },
    },
    async (req) => {
      const spec = readDrill(d.keyring, req.query.token, req.actor!.userId, d.clock());
      const { ids, capped } = await drillIds(req, spec);
      const page = await listLeads(req, {
        ids,
        limit: 50,
        sort: "newest",
        ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
      });
      // Capped: the first DRILL_MAX of a bigger number (the board shows the whole of it).
      return { kind: spec.k, total: ids.length, capped, ...page };
    },
  );
}
