import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { METRICS, type MetricId } from "@lume/core";
import type { AppDeps } from "../../app";
import { listLeads } from "../leads/query";
import { drillFor, drillIds, readDrill } from "./drill";
import { listGoals, removeGoal, setGoal, setSpend } from "./goals";
import { insights } from "./insights";
import { lost, quality, sources, templates, timing } from "./modules";
import { businessTz, funnel, overview, rangeOf, team, type AnalyticsQuery } from "./service";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const query = z
  .object({
    range: z
      .enum(["today", "yesterday", "7d", "30d", "90d", "this_month", "last_month", "this_quarter", "custom"])
      .default("30d"),
    from: day.optional(),
    to: day.optional(),
    compare: z.enum(["0", "1"]).default("1"),
    pipeline: z.uuid().optional(),
    owner: z.union([z.uuid(), z.literal("none")]).optional(),
    source: z.uuid().optional(),
  })
  .refine((q) => q.range !== "custom" || (q.from && q.to), "A custom range needs from and to");

type Raw = z.infer<typeof query>;
const toQuery = (q: Raw): AnalyticsQuery => ({
  range: q.range,
  ...(q.from ? { from: q.from } : {}),
  ...(q.to ? { to: q.to } : {}),
  compare: q.compare === "1",
  ...(q.pipeline ? { pipelineId: q.pipeline } : {}),
  ...(q.owner ? { ownerId: q.owner } : {}),
  ...(q.source ? { sourceId: q.source } : {}),
});

/**
 * Analytics (8A, spec §5.2), for anyone with analytics.view, at their reach. Each module answers with its numbers and,
 * for every number with leads behind it, a drill-down token valid for 15 minutes.
 */
export async function analyticsRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const view = { permission: "analytics.view" as const };

  r.get("/api/v1/analytics/overview", { config: view, schema: { querystring: query } }, async (req) => {
    const q = toQuery(req.query);
    const now = d.clock();
    const body = await overview(req, q, now);
    const tz = await businessTz(req);
    const range = rangeOf(q, tz, now);
    const drill: Partial<Record<MetricId, string>> = {};
    for (const t of body.tiles)
      if (METRICS[t.id].drill) drill[t.id] = drillFor(d, req, range, q, tz, t.id, undefined, now);
    return { ...body, drill };
  });
  r.get("/api/v1/analytics/funnel", { config: view, schema: { querystring: query } }, (req) =>
    funnel(req, toQuery(req.query), d.clock()),
  );
  r.get("/api/v1/analytics/team", { config: view, schema: { querystring: query } }, (req) =>
    team(req, toQuery(req.query), d.clock()),
  );

  // Modules that carry drill tokens take the keyring; the rest ignore it.
  const reads: Record<
    string,
    (req: FastifyRequest, q: AnalyticsQuery, now: Date, deps: AppDeps) => Promise<unknown>
  > = { sources, lost, timing, templates, quality };
  for (const [name, read] of Object.entries(reads))
    r.get(`/api/v1/analytics/${name}`, { config: view, schema: { querystring: query } }, (req) =>
      read(req, toQuery(req.query), d.clock(), d),
    );
  r.get("/api/v1/analytics/insights", { config: view, schema: { querystring: query } }, (req) =>
    insights(req, toQuery(req.query), d.clock()),
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
      const ids = await drillIds(req, spec);
      const page = await listLeads(req, {
        ids,
        limit: 50,
        sort: "newest",
        ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
      });
      return { kind: spec.k, total: ids.length, ...page };
    },
  );
}
