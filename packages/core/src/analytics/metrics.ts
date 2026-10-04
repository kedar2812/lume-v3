/**
 * The metric catalogue (spec §2, §4): every number analytics shows, declared once. The API computes from these
 * definitions, the screens label and explain with them, the drill-downs open their leads, and the weekly email
 * words them. Change a definition here and in the spec together.
 */
export type MetricBasis = "cohort" | "event" | "now";
export type MetricUnit = "count" | "pct" | "money" | "duration" | "days";

export type MetricDef = {
  id: MetricId;
  words: string;
  basis: MetricBasis;
  unit: MetricUnit;
  /** How a change is shown (the owner's trend rule): a relative %, percentage points, or the plain difference. */
  trendKind: "pct" | "pts" | "abs";
  good: "up" | "down";
  /** Absent for anyone without analytics.revenue. */
  revenue: boolean;
  /** Whether its number opens the leads behind it. */
  drill: boolean;
  /** The info tooltip: what it counts, and on which basis. */
  info: string;
};

const COHORT = "Follows the leads that arrived in the range.";
const EVENT = "Counts what happened in the range.";
const NOW = "As it stands right now.";

const def = (d: Omit<MetricDef, "revenue" | "drill"> & Partial<Pick<MetricDef, "revenue" | "drill">>) => ({
  revenue: false,
  drill: true,
  ...d,
});

export const METRICS = {
  new_leads: def({
    id: "new_leads",
    words: "New leads",
    basis: "cohort",
    unit: "count",
    trendKind: "pct",
    good: "up",
    info: `Leads that arrived in the range. ${COHORT}`,
  }),
  contacted: def({
    id: "contacted",
    words: "Contacted",
    basis: "cohort",
    unit: "pct",
    trendKind: "pts",
    good: "up",
    info: `Of new leads, the share messaged, called or booked so far. ${COHORT}`,
  }),
  reply_rate: def({
    id: "reply_rate",
    words: "Reply rate",
    basis: "cohort",
    unit: "pct",
    trendKind: "pts",
    good: "up",
    info: `Of new leads contacted, the share that replied so far. ${COHORT}`,
  }),
  speed_to_lead: def({
    id: "speed_to_lead",
    words: "Speed to lead",
    basis: "cohort",
    unit: "duration",
    trendKind: "pct",
    good: "down",
    info: `The median time from a lead arriving (or being assigned) to its first contact. Leads not contacted yet are counted apart. ${COHORT}`,
  }),
  calls_booked: def({
    id: "calls_booked",
    words: "Calls booked",
    basis: "event",
    unit: "count",
    trendKind: "pct",
    good: "up",
    info: `Calls booked in the range; a reschedule isn't a new booking. ${EVENT}`,
  }),
  calls_held: def({
    id: "calls_held",
    words: "Calls held",
    basis: "event",
    unit: "count",
    trendKind: "pct",
    good: "up",
    info: `Calls that took place in the range. ${EVENT}`,
  }),
  no_show_rate: def({
    id: "no_show_rate",
    words: "No-show rate",
    basis: "event",
    unit: "pct",
    trendKind: "pts",
    good: "down",
    info: `Of calls due in the range that either happened or were missed, the share missed. ${EVENT}`,
  }),
  won: def({
    id: "won",
    words: "Won",
    basis: "event",
    unit: "count",
    trendKind: "pct",
    good: "up",
    info: `Leads won in the range, credited to whoever owned them then. ${EVENT}`,
  }),
  win_rate: def({
    id: "win_rate",
    words: "Win rate",
    basis: "cohort",
    unit: "pct",
    trendKind: "pts",
    good: "up",
    info: `Of new leads, the share won so far. ${COHORT}`,
  }),
  revenue_won: def({
    id: "revenue_won",
    words: "Revenue won",
    basis: "event",
    unit: "money",
    trendKind: "pct",
    good: "up",
    revenue: true,
    info: `The value of leads won in the range. Leads won without a value are counted apart. ${EVENT}`,
  }),
  avg_deal: def({
    id: "avg_deal",
    words: "Average deal",
    basis: "event",
    unit: "money",
    trendKind: "pct",
    good: "up",
    revenue: true,
    info: `Revenue won divided by the leads won that have a value. ${EVENT}`,
  }),
  overdue_now: def({
    id: "overdue_now",
    words: "Follow-ups overdue",
    basis: "now",
    unit: "count",
    trendKind: "abs",
    good: "down",
    info: `Open follow-ups past their time. ${NOW}`,
  }),
  ontime: def({
    id: "ontime",
    words: "Follow-ups on time",
    basis: "event",
    unit: "pct",
    trendKind: "pts",
    good: "up",
    info: `Of follow-ups due in the range and done, the share done by their time (5 minutes' grace). ${EVENT}`,
  }),
  lateness: def({
    id: "lateness",
    words: "Average lateness",
    basis: "event",
    unit: "duration",
    trendKind: "pct",
    good: "down",
    info: `How late the late follow-ups due in the range were, on average. ${EVENT}`,
  }),
  forecast: def({
    id: "forecast",
    words: "Pipeline forecast",
    basis: "now",
    unit: "money",
    trendKind: "pct",
    good: "up",
    revenue: true,
    info: `Open leads' value, each weighted by its stage's chance of winning. An estimate. ${NOW}`,
  }),
  cycle: def({
    id: "cycle",
    words: "Days to win",
    basis: "event",
    unit: "days",
    trendKind: "pct",
    good: "down",
    info: `The median days from arrival to winning, for leads won in the range. ${EVENT}`,
  }),
  velocity: def({
    id: "velocity",
    words: "Pipeline velocity",
    basis: "now",
    unit: "money",
    trendKind: "pct",
    good: "up",
    revenue: true,
    drill: false,
    info: `Revenue the pipeline moves a day at the last 90 days' pace: open leads × win rate × average deal ÷ days to win. An estimate. ${NOW}`,
  }),
  lost: def({
    id: "lost",
    words: "Lost",
    basis: "event",
    unit: "count",
    trendKind: "pct",
    good: "down",
    info: `Leads marked lost in the range. ${EVENT}`,
  }),
  won_back: def({
    id: "won_back",
    words: "Won back",
    basis: "event",
    unit: "count",
    trendKind: "abs",
    good: "up",
    info: `Leads once lost, reopened and won in the range. ${EVENT}`,
  }),
} as const satisfies Record<string, MetricDef>;

export type MetricId =
  | "new_leads"
  | "contacted"
  | "reply_rate"
  | "speed_to_lead"
  | "calls_booked"
  | "calls_held"
  | "no_show_rate"
  | "won"
  | "win_rate"
  | "revenue_won"
  | "avg_deal"
  | "overdue_now"
  | "ontime"
  | "lateness"
  | "forecast"
  | "cycle"
  | "velocity"
  | "lost"
  | "won_back";

export const METRIC_IDS = Object.keys(METRICS) as MetricId[];
