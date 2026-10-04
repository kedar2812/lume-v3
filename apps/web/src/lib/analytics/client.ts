"use client";
import type { MetricId, RangePreset, Trend } from "@lume/core/shared";
import { api } from "@/lib/api";
import type { LeadPage } from "@/lib/leads/types";

/** The analytics API's answers (8A/8B), as the screens read them. */
export type Tile = {
  id: MetricId;
  value: number | null;
  previous: number | null;
  trend: Trend | null;
  n?: number;
  note?: string;
};
export type RangeView = { label: string; days: string[]; from?: string; to?: string };
export type Overview = {
  range: RangeView;
  tiles: Tile[];
  series: {
    days: string[];
    newLeads: number[];
    won: number[];
    previous: { newLeads: number[]; won: number[] };
    bySource: { id: string | null; name: string; values: number[] }[];
  };
  drill: Partial<Record<MetricId, string>>;
};
export type FunnelStage = {
  id: string;
  name: string;
  kind: string;
  reached: number;
  share: number | null;
  stopped: number | null;
  stoppedN: number;
  tooFew: boolean;
  trend: Trend | null;
};
export type Funnel = { range: RangeView; arrived: number; previousArrived: number; stages: FunnelStage[] };
export type TeamRow = {
  id: string;
  name: string;
  active: boolean;
  newLeads: number;
  contacted: number | null;
  speedToLead: number | null;
  won: number;
  revenueWon?: number;
  ontime: number | null;
  overdueNow: number;
};
export type Team = { range: RangeView; leaderboard: boolean; people: TeamRow[] };
export type SourceRow = {
  id: string | null;
  name: string;
  leads: number;
  leadShare: number | null;
  winRate: number | null;
  tooFew: boolean;
  won: number;
  revenue?: number;
  revenueShare?: number | null;
  spend?: number | null;
  costPerLead?: number | null;
  returnPerSpent?: number | null;
};
export type Sources = { range: RangeView; sources: SourceRow[]; revenueByDay?: number[] };
export type Lost = {
  range: RangeView;
  total: number;
  previousTotal: number | null;
  reasons: {
    id: string | null;
    name: string;
    n: number;
    before: number;
    share: number | null;
    trend: Trend | null;
  }[];
  stages: { id: string | null; name: string; n: number }[];
  owners: { id: string | null; n: number }[];
  sources: { id: string | null; n: number }[];
  wonBack: { n: number; value?: number };
};
export type Cell = { rate: number | null; n: number; tooFew?: boolean };
export type Timing = {
  range: RangeView;
  arrivals: number[][];
  replies: Cell[][];
  booking: Cell[][];
  stages: {
    id: string;
    name: string;
    exited: number;
    medianMinutes: number | null;
    p75Minutes: number | null;
    tooFew: boolean;
    stuckNow: number;
  }[];
};
export type Templates = {
  range: RangeView;
  templates: {
    id: string;
    name: string;
    sends: number;
    replies: number;
    wins: number;
    replyRate: number | null;
    tooFew: boolean;
  }[];
};
export type Quality = {
  range: RangeView;
  phoneNeedsCountry: number;
  phoneInvalid: number;
  unowned: { under1h: number; under1d: number; over1d: number };
  importsRejected: { source_id: string; name: string; errors: number; skipped: number }[];
};
export type Insights =
  | { ready: false; title: string; body: string; progress: string; insights: [] }
  | {
      ready: true;
      insights: { id: string; subject: string; title: string; body: string; magnitude: number }[];
    };
export type Goals = {
  period: "month" | "quarter";
  periodStart: string;
  periodEnd: string;
  goals: {
    id: string;
    scope: "user" | "team" | "business";
    scopeId: string | null;
    metric: "won" | "revenue" | "calls_held" | "new_leads" | "ontime";
    target: number;
    value: number;
    progress: number;
    pace: number | null;
    elapsed: number;
    daysLeft: number;
  }[];
};

export type AnalyticsParams = {
  range: RangePreset;
  from?: string;
  to?: string;
  compare: boolean;
  pipeline?: string;
  owner?: string;
  source?: string;
};
export function query(p: AnalyticsParams): string {
  const q = new URLSearchParams({ range: p.range, compare: p.compare ? "1" : "0" });
  for (const k of ["from", "to", "pipeline", "owner", "source"] as const) if (p[k]) q.set(k, p[k]!);
  return q.toString();
}

export const analyticsClient = {
  overview: (p: AnalyticsParams) => api.get<Overview>(`/api/v1/analytics/overview?${query(p)}`),
  funnel: (p: AnalyticsParams) => api.get<Funnel>(`/api/v1/analytics/funnel?${query(p)}`),
  team: (p: AnalyticsParams) => api.get<Team>(`/api/v1/analytics/team?${query(p)}`),
  sources: (p: AnalyticsParams) => api.get<Sources>(`/api/v1/analytics/sources?${query(p)}`),
  lost: (p: AnalyticsParams) => api.get<Lost>(`/api/v1/analytics/lost?${query(p)}`),
  timing: (p: AnalyticsParams) => api.get<Timing>(`/api/v1/analytics/timing?${query(p)}`),
  templates: (p: AnalyticsParams) => api.get<Templates>(`/api/v1/analytics/templates?${query(p)}`),
  quality: (p: AnalyticsParams) => api.get<Quality>(`/api/v1/analytics/quality?${query(p)}`),
  insights: (p: AnalyticsParams) => api.get<Insights>(`/api/v1/analytics/insights?${query(p)}`),
  goals: (start: string) => api.get<Goals>(`/api/v1/analytics/goals?start=${start}`),
  drill: (token: string, cursor?: string) =>
    api.get<LeadPage & { metric: MetricId; total: number }>(
      `/api/v1/analytics/drilldown?token=${encodeURIComponent(token)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),
};
