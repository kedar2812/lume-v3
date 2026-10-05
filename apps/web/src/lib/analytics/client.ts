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
/** Today's quick stats: four tiles, each with its daily line and the period it's measured over. */
export type Glance = {
  kpis: (Tile & { series: (number | null)[]; period: "week" | "month" })[];
  week: { from: string; to: string };
  month: { from: string; to: string };
};
export type Overview = {
  range: RangeView;
  tiles: Tile[];
  series: {
    days: string[];
    newLeads: number[];
    won: number[];
    previous: { newLeads: number[]; won: number[] };
    bySource: { id: string | null; name: string; values: number[] }[];
    /** Each tile's value day by day (null: nothing to divide that day). "Right now" numbers have none. */
    tiles?: Partial<Record<MetricId, (number | null)[]>>;
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
export type Funnel = {
  range: RangeView;
  arrived: number;
  previousArrived: number;
  stages: (FunnelStage & {
    previousReached?: number;
    previousStoppedN?: number;
    drill?: { reached?: string; stopped?: string };
  })[];
  /** Each source's (or owner's) own funnel, when asked to split (the five biggest, the rest together). */
  split?: {
    by: "source" | "owner";
    groups: {
      id: string | null;
      name: string;
      arrived: number;
      stages: { id: string; reached: number; share: number | null }[];
    }[];
  };
  /** Open leads in each stage right now, whatever the range. */
  now?: {
    stages: {
      id: string;
      name: string;
      n: number;
      value?: number;
      avgAgeDays: number | null;
      drill?: string;
    }[];
    openN: number;
    openValue: number | null;
  };
  timeInStage?: {
    id: string;
    name: string;
    exited: number;
    medianMinutes: number | null;
    p75Minutes: number | null;
    slaHours: number | null;
    stuckNow: number;
    tooFew: boolean;
    drill?: { stuck?: string };
  }[];
  timeInStageNote?: string;
  /** With the money permission: what the pipeline earns a day, and how long wins take. */
  velocity?: {
    openLeads: number;
    winRate: number | null;
    avgDeal: number | null;
    cycleDays: number | null;
    perDay: number | null;
    previousPerDay: number | null;
    trend: Trend | null;
    cycleHist?: { edges: number[]; counts: number[]; median: number | null };
  } | null;
  forecast?: {
    months: { month: string; label: string; latest: number; second: number; earlier: number }[];
    later: number;
    stageNames: [string, string];
  } | null;
};
/** What the leaderboard ranks by ("revenue" only for someone with analytics.revenue). */
export type RankMetric = "won" | "revenue" | "speed" | "ontime" | "replies";
export type TeamRow = {
  id: string;
  name: string;
  active: boolean;
  newLeads: number;
  assigned: number;
  contacted: number | null;
  within1h: number | null;
  replyRate: number | null;
  speedToLead: number | null;
  held: number;
  won: number;
  revenueWon?: number;
  ontime: number | null;
  overdueNow: number;
  /** Each metric's place and value the period before (null: not ranked, or nothing then). */
  previousRank: Partial<Record<RankMetric, number | null>>;
  previous: Partial<Record<RankMetric, number | null>>;
  goal: { metric: "won" | "revenue"; target: number; value: number } | null;
  drill: { cohort?: string; won?: string };
};
export type Team = {
  range: RangeView;
  leaderboard: boolean;
  people: TeamRow[];
  discipline: {
    ontime: number | null;
    previousOntime: number | null;
    trend: Trend | null;
    overdueNow: number;
    people: { id: string; ontime: number | null; overdueNow: number }[];
  };
};
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
/** Revenue (8D-1): the month against its goal, the last twelve months, and the money by package. Money only. */
export type Revenue = {
  range: RangeView;
  thisMonth: {
    days: string[];
    cumulative: number[];
    goal: number | null;
    /** Where this pace would end the month (none before a fifth of it has gone). */
    paceEnd: number | null;
    today: string;
    daysInMonth: number;
  };
  /** Twelve months to this one (none under a tag or field filter). */
  byMonth: { month: string; label: string; value: number; goal: number | null }[] | null;
  byProduct: {
    id: string | null;
    name: string;
    deals: number;
    value: number;
    share: number | null;
    drill?: string;
  }[];
  fact: { product: string; dealShare: number; revenueShare: number } | null;
  total: number;
  previousTotal: number | null;
  trend: Trend | null;
  drill?: string;
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
    drill?: string;
  }[];
  stages: { id: string | null; name: string; n: number; drill?: string }[];
  owners: { id: string | null; n: number }[];
  sources: { id: string | null; n: number }[];
  wonBack: { n: number; value?: number; drill?: string };
  /** Reasons by source: the six commonest reasons × the five biggest sources; under 3 is thin. */
  matrix: {
    reasons: { id: string | null; name: string }[];
    sources: { id: string | null; name: string }[];
    cells: { reasonId: string | null; sourceId: string | null; n: number; tooFew: boolean; drill?: string }[];
  };
  /** Lost in the range, reopened after, then won (money only with analytics.revenue). */
  wonBackFlow: {
    lost: number;
    reopened: number;
    won: number;
    value?: number;
    previousValue?: number | null;
    trend: Trend | null;
    drill?: string;
  };
};
/** What converts: win rate by each answer to a choice, multiple-choice or yes/no field. */
export type Segments = {
  range: RangeView;
  field: { key: string; label: string; type: string } | null;
  groups: {
    value: string | null;
    label: string;
    arrived: number;
    won: number;
    rate: number | null;
    tooFew: boolean;
    drill?: string;
  }[];
  fields: { key: string; label: string; type: string }[];
};
export type Cell = { rate: number | null; n: number; tooFew?: boolean };
type MeetingKpis = {
  booked: number;
  held: number;
  heldRate: number | null;
  noShowRate: number | null;
  cancelled: number;
};
export type Timing = {
  range: RangeView;
  /** The hours each grid shows (7 am – 10 pm); what falls outside is counted apart in `outside`. */
  window: { startHour: number; endHour: number };
  /** [weekday 0 = Sunday][hour 0–23], in the business's time. */
  arrivals: number[][];
  replies: Cell[][];
  booking: Cell[][];
  outside: { arrivals: number; sends: number; replies: number; booked: number; held: number };
  best: {
    arrivals?: { dow: number; hour: number; n: number };
    replies?: { dow: number; hour: number; rate: number; n: number };
    booking?: { dow: number; hour: number; rate: number; n: number };
  };
  /** Each cell's leads (a drill token where there are any). */
  cells: Record<"arrivals" | "replies" | "booking", { n: number; drill?: string }[][]>;
  meetings: {
    kpis: MeetingKpis & { previous: MeetingKpis };
    flow: {
      booked: number;
      held: number;
      noShow: number;
      cancelled: number;
      rescheduled: number;
      upcoming: number;
    };
    people: { id: string; name: string; held: number; noShow: number; cancelled: number }[];
    drill: { held?: string; no_show?: string; cancelled?: string };
  };
  stages: {
    id: string;
    name: string;
    exited: number;
    medianMinutes: number | null;
    p75Minutes: number | null;
    tooFew: boolean;
    stuckNow: number;
  }[];
  note?: string;
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
  /** Every lead's phone, across the business (a snapshot every 10 minutes). */
  phones: {
    total: number;
    readable: number;
    readableShare: number | null;
    needsCountry: number;
    invalid: number;
    drill: { needsCountry?: string; invalid?: string };
  };
  duplicatesMerged: number;
  phoneNeedsCountry: number;
  phoneInvalid: number;
  unowned: {
    under1h: number;
    under1d: number;
    under7d: number;
    over7d: number;
    over1d: number;
    oldestMinutes: number | null;
    drill: Partial<Record<"under_1h" | "under_1d" | "under_7d" | "over_7d", string>>;
  };
  imports: { sourceId: string; name: string; rows: number; rejected: number }[];
  importsRejected: { source_id: string; name: string; errors: number; skipped: number }[];
  sourcesNeedingLook: { id: string; name: string; type: string; status: string; message: string | null }[];
  /** Unowned leads, sources and imports were counted (the viewer sees the whole business). */
  seesAll: boolean;
};
export type Insights =
  | { ready: false; title: string; body: string; progress: string; insights: [] }
  | {
      ready: true;
      insights: { id: string; subject: string; title: string; body: string; magnitude: number }[];
    };
/** A rep's own analytics (canvas Rep): always the viewer's own numbers. */
export type Me = {
  range: RangeView;
  heroLine: string;
  goals: {
    metric: "won" | "revenue" | "calls_held" | "new_leads" | "ontime";
    target: number;
    value: number;
    pace: number | null;
  }[];
  tiles: Tile[];
  followUps: {
    dueNow: number;
    ontime: number | null;
    next: { id: string; leadId: string; leadName: string; title: string; dueAt: string }[];
  };
  funnel: {
    stages: { id: string; name: string; share: number | null }[];
    myWinRate: number | null;
    businessWinRate: number | null;
  };
  replyDays: { dow: number; sends: number; rate: number | null; tooFew: boolean }[];
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
  /** One person (kept for the screens that pick one), or several. */
  owner?: string;
  owners?: string[];
  team?: string;
  source?: string;
  sources?: string[];
  tags?: string[];
  fields?: Record<string, string[]>;
  /** The funnel, split by source or owner. */
  split?: "source" | "owner";
};
export function query(p: AnalyticsParams): string {
  const q = new URLSearchParams({ range: p.range, compare: p.compare ? "1" : "0" });
  for (const k of ["from", "to", "pipeline", "team", "split"] as const) if (p[k]) q.set(k, p[k]!);
  const owners = p.owners?.length ? p.owners : p.owner ? [p.owner] : [];
  const sources = p.sources?.length ? p.sources : p.source ? [p.source] : [];
  if (owners.length) q.set("owner", owners.join(","));
  if (sources.length) q.set("source", sources.join(","));
  if (p.tags?.length) q.set("tag", p.tags.join(","));
  if (p.fields && Object.keys(p.fields).length) q.set("fields", JSON.stringify(p.fields));
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
  revenue: (p: AnalyticsParams) => api.get<Revenue>(`/api/v1/analytics/revenue?${query(p)}`),
  me: (p: AnalyticsParams) => api.get<Me>(`/api/v1/analytics/me?${query(p)}`),
  segments: (p: AnalyticsParams, field?: string) =>
    api.get<Segments>(
      `/api/v1/analytics/segments?${query(p)}${field ? `&field=${encodeURIComponent(field)}` : ""}`,
    ),
  /** The teams the Filters panel offers: none for someone who sees only their own leads. */
  teams: () =>
    api.get<{ teams: { id: string; name: string; memberIds: string[] }[] }>("/api/v1/analytics/teams"),
  glance: () => api.get<Glance>("/api/v1/analytics/glance"),
  /** Recount now (Analytics' Refresh): at most once a minute for the business; says when it last counted. */
  refresh: () => api.post<{ recounted: boolean; countedAt: string | null }>("/api/v1/analytics/refresh"),
  insights: (p: AnalyticsParams) => api.get<Insights>(`/api/v1/analytics/insights?${query(p)}`),
  goals: (start: string, period: "month" | "quarter" = "month") =>
    api.get<Goals>(`/api/v1/analytics/goals?start=${start}&period=${period}`),
  setGoal: (g: {
    scope: "user" | "team" | "business";
    scopeId: string | null;
    metric: Goals["goals"][number]["metric"];
    period: "month" | "quarter";
    periodStart: string;
    target: number;
  }) => api.put<{ id: string }>("/api/v1/analytics/goals", g),
  removeGoal: (id: string) => api.del<void>(`/api/v1/analytics/goals/${id}`),
  drill: (token: string, cursor?: string) =>
    // capped: the first 10,000 of a bigger number.
    api.get<LeadPage & { kind: string; total: number; capped: boolean }>(
      `/api/v1/analytics/drilldown?token=${encodeURIComponent(token)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),
};
