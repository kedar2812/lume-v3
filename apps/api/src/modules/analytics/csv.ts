import Papa from "papaparse";
import type { FastifyReply, FastifyRequest } from "fastify";
import { METRICS, can, type MetricId } from "@lume/core";
import { HttpError } from "../../http/errors";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { safeCell } from "../../export/service";
import { funnel } from "./funnel";
import { lost, quality, sources, templates, timing } from "./modules";
import { revenue } from "./revenue";
import { businessTz, overview, rangeOf, seesRevenue, type AnalyticsQuery, type Tile } from "./service";
import { team } from "./team";

/**
 * A board's numbers as CSV (8D spec §4 Export): labels and numbers only — people's and sources' names are labels,
 * never a lead's name, phone or email. Every cell made safe from spreadsheet formulas, and audited like an export.
 */
export const CSV_MODULES = [
  "overview",
  "funnel",
  "team",
  "sources",
  "revenue",
  "lost",
  "timing",
  "templates",
  "quality",
] as const;
export type CsvModule = (typeof CSV_MODULES)[number];
type Cell = string | number | null;
type Table = { header: string[]; rows: Cell[][] };

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const n = (v: number | null | undefined): Cell =>
  v === null || v === undefined ? null : Math.round(v * 1e6) / 1e6;

async function table(req: FastifyRequest, m: CsvModule, q: AnalyticsQuery, now: Date): Promise<Table> {
  const money = seesRevenue(req);
  switch (m) {
    case "overview": {
      const o = await overview(req, q, now);
      return {
        header: ["Measure", "Value", "Period before"],
        rows: o.tiles.map((t: Tile) => [METRICS[t.id as MetricId].words, n(t.value), n(t.previous)]),
      };
    }
    case "funnel": {
      const f = await funnel(req, q, now);
      return {
        header: ["Stage", "Reached", "Share of new leads", "Went no further"],
        rows: f.stages.map((s) => [s.name, s.reached, n(s.share), s.stoppedN]),
      };
    }
    case "team": {
      const t = await team(req, q, now);
      return {
        header: [
          "Person",
          "New leads",
          "Contacted",
          "Within an hour",
          "Reply rate",
          "Speed to lead (minutes)",
          "Calls held",
          "Won",
          ...(money ? ["Revenue won"] : []),
          "On time",
          "Overdue now",
        ],
        rows: t.people.map((p) => [
          p.name,
          p.assigned,
          n(p.contacted),
          n(p.within1h),
          n(p.replyRate),
          n(p.speedToLead),
          p.held,
          p.won,
          ...(money ? [n((p as { revenueWon?: number }).revenueWon ?? 0)] : []),
          n(p.ontime),
          p.overdueNow,
        ]),
      };
    }
    case "sources": {
      const s = await sources(req, q, now);
      return {
        header: [
          "Source",
          "Leads",
          "Share of leads",
          "Win rate",
          "Won",
          ...(money ? ["Revenue won", "Spend", "Cost per lead", "Revenue per 1 spent"] : []),
        ],
        rows: s.sources.map((x) => {
          const r = x as typeof x & {
            revenue?: number;
            spend?: number | null;
            costPerLead?: number | null;
            returnPerSpent?: number | null;
          };
          return [
            x.name,
            x.leads,
            n(x.leadShare),
            n(x.winRate),
            x.won,
            ...(money ? [n(r.revenue), n(r.spend), n(r.costPerLead), n(r.returnPerSpent)] : []),
          ];
        }),
      };
    }
    case "revenue": {
      const r = await revenue(req, q, now);
      return {
        header: ["Month", "Revenue won", "Goal"],
        rows: (r.byMonth ?? []).map((x) => [x.month, n(x.value), n(x.goal)]),
      };
    }
    case "lost": {
      const l = await lost(req, q, now);
      return { header: ["Reason", "Lost", "Share"], rows: l.reasons.map((r) => [r.name, r.n, n(r.share)]) };
    }
    case "timing": {
      const t = await timing(req, q, now);
      const rows: Cell[][] = [];
      for (let d = 0; d < 7; d++)
        for (let h = 0; h < 24; h++)
          rows.push([
            DAYS[d]!,
            h,
            t.arrivals[d]![h]!,
            t.replies[d]![h]!.n,
            n(t.replies[d]![h]!.rate),
            t.booking[d]![h]!.n,
            n(t.booking[d]![h]!.rate),
          ]);
      return {
        header: ["Day", "Hour", "New leads", "Messages sent", "Reply rate", "Calls booked", "Held rate"],
        rows,
      };
    }
    case "templates": {
      const t = await templates(req, q, now);
      return {
        header: ["Template", "Sent", "Replies", "Reply rate", "Won within 30 days"],
        rows: t.templates.map((x) => [x.name, x.sends, x.replies, n(x.replyRate), x.wins]),
      };
    }
    case "quality": {
      const x = await quality(req, q, now);
      return {
        header: ["Measure", "Value"],
        rows: [
          ["Phone numbers LUME can read", x.phones.readable],
          ["Phone numbers needing a country", x.phones.needsCountry],
          ["Phone numbers that can't be read", x.phones.invalid],
          ["Duplicates merged", x.duplicatesMerged],
          ["Unowned under an hour", x.unowned.under1h],
          ["Unowned under a day", x.unowned.under1d],
          ["Unowned under a week", x.unowned.under7d],
          ["Unowned a week or more", x.unowned.over7d],
          ...x.imports.map((i): Cell[] => [`Rows rejected from ${i.name}`, i.rejected]),
        ],
      };
    }
  }
}

export async function boardCsv(
  req: FastifyRequest,
  reply: FastifyReply,
  d: Pick<AppDeps, "clock">,
  m: CsvModule,
  q: AnalyticsQuery,
) {
  if (!can(req.actor!, "leads.export"))
    throw new HttpError(403, "NO_EXPORT_ACCESS", "Exporting is only for people allowed to export.");
  const now = d.clock();
  const range = rangeOf(q, await businessTz(req), now);
  const t = await table(req, m, q, now);
  const safe = (r: Cell[]) => r.map((v) => (v === null ? "" : safeCell(v)));
  const body = `\uFEFF${Papa.unparse([t.header, ...t.rows.map(safe)], { newline: "\r\n" })}\r\n`;
  const [from, to] = [range.days[0]!, range.days.at(-1)!];
  await audit(req, {
    action: "analytics.export",
    entityType: "analytics",
    entityId: m,
    diff: { module: m, from, to, rows: t.rows.length },
  });
  return reply
    .header("content-type", "text/csv; charset=utf-8")
    .header("content-disposition", `attachment; filename="lume-${m}-${from}-${to}.csv"`)
    .header("cache-control", "no-store")
    .send(body);
}
