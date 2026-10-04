import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { METRICS, type MetricId } from "@lume/core";
import type { AppDeps } from "../../app";
import { listLeads } from "../leads/query";
import { drillIds, mintDrill, readDrill } from "./drill";
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
    const range = rangeOf(q, await businessTz(req), now);
    const drill: Partial<Record<MetricId, string>> = {};
    for (const t of body.tiles)
      if (METRICS[t.id].drill)
        drill[t.id] = mintDrill(
          d.keyring,
          {
            m: t.id,
            d: [range.days[0]!, range.days.at(-1)!],
            t: [range.from.toISOString(), range.to.toISOString()],
            q: {
              ...(q.pipelineId ? { pipelineId: q.pipelineId } : {}),
              ...(q.ownerId ? { ownerId: q.ownerId } : {}),
              ...(q.sourceId ? { sourceId: q.sourceId } : {}),
            },
            u: req.actor!.userId,
          },
          now,
        );
    return { ...body, drill };
  });
  r.get("/api/v1/analytics/funnel", { config: view, schema: { querystring: query } }, (req) =>
    funnel(req, toQuery(req.query), d.clock()),
  );
  r.get("/api/v1/analytics/team", { config: view, schema: { querystring: query } }, (req) =>
    team(req, toQuery(req.query), d.clock()),
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
      return { metric: spec.m, total: ids.length, ...page };
    },
  );
}
