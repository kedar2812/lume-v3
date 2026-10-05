/** Goals (8D-3, canvas Goals): the month or quarter a goal is for, and how its amounts are typed and suggested. */
export type GoalPeriod = "month" | "quarter";
export type GoalMetric = "revenue" | "won" | "calls_held" | "new_leads" | "ontime";

const iso = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}-01`;
const ym = (start: string) => start.split("-").map(Number) as [number, number, number];

/** The first day of the month or quarter that `today` falls in. */
export function periodOf(today: string, period: GoalPeriod): string {
  const [y, m] = ym(today);
  return period === "month" ? iso(y, m) : iso(y, Math.floor((m - 1) / 3) * 3 + 1);
}

/** The period `by` steps away (−1: the one before). */
export function shiftPeriod(start: string, period: GoalPeriod, by: number): string {
  const [y, m] = ym(start);
  const n = y * 12 + (m - 1) + by * (period === "month" ? 1 : 3);
  return iso(Math.floor(n / 12), (n % 12) + 1);
}

/** Its last day. */
export function periodLast(start: string, period: GoalPeriod): string {
  const next = shiftPeriod(start, period, 1);
  const d = new Date(`${next}T00:00:00Z`);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

/** "October 2026", "Q4 2026"; and the short name a hint uses ("Sep", "Q3"). */
export function periodWords(start: string, period: GoalPeriod): { label: string; short: string } {
  const [y, m] = ym(start);
  if (period === "quarter") {
    const q = Math.floor((m - 1) / 3) + 1;
    return { label: `Q${q} ${y}`, short: `Q${q}` };
  }
  const d = new Date(`${start}T12:00:00Z`);
  return {
    label: d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
    short: d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
  };
}

/** A typed amount: grouping and a trailing % are fine; nothing, or not a positive number, is null (no goal). */
export function parseTarget(raw: string, metric: GoalMetric): number | null {
  const t = raw.replace(/[,\s%]/g, "").trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  // On time is a share typed as a percent (90 → 0.9), never above all of them.
  if (metric === "ontime") return n > 100 ? null : n / 100;
  return metric === "revenue" ? Math.round(n * 100) / 100 : Math.round(n);
}

/** How a saved target shows in its box: grouped the way the currency reads (Indian lakh grouping for INR). */
export function targetText(v: number | null, metric: GoalMetric, currency: string): string {
  if (v === null) return "";
  if (metric === "ontime") return String(Math.round(v * 1000) / 10);
  return v.toLocaleString(currency === "INR" ? "en-IN" : "en-US", { maximumFractionDigits: 2 });
}

/** "Same" and "+10%": the period before's actual, as it is and a tenth up (a share stays at or under 100%). */
export function suggestions(before: number | null, metric: GoalMetric): { same: number; up: number } | null {
  if (before === null || before <= 0) return null;
  if (metric === "ontime") return { same: before, up: Math.min(1, Math.round(before * 1.1 * 100) / 100) };
  const round = (x: number) => (metric === "revenue" ? Math.round(x) : Math.round(x));
  return { same: round(before), up: round(before * 1.1) };
}
