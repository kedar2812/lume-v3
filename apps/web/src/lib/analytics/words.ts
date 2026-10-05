import { METRICS, type MetricId } from "@lume/core/shared";
import type { Tile } from "./client";

/**
 * How analytics says its numbers (8C): one formatter per unit, and a headline worked out from the tiles — the
 * biggest move that's good, or the biggest that isn't — never a stock phrase that doesn't match the numbers.
 */
export function money(n: number, currency: string, compact = true): string {
  const short = compact && Math.abs(n) >= 10_000;
  try {
    // Rupees read in lakh and crore (₹58.4L, ₹6.2Cr, ₹64,00,000); every other currency in K and M.
    return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
      style: "currency",
      currency,
      notation: short ? "compact" : "standard",
      minimumFractionDigits: 0,
      maximumFractionDigits: short ? 1 : 0,
    }).format(n);
  } catch {
    return `${currency} ${Math.round(n).toLocaleString("en-US")}`;
  }
}
export const count = (n: number) => Math.round(n).toLocaleString("en-US");
export const pct = (x: number, places = 0) => `${(x * 100).toFixed(places)}%`;
export function minutes(m: number): string {
  if (m < 1) return "under a minute";
  if (m < 60) return `${Math.round(m)} min`;
  if (m < 1440) {
    const h = Math.floor(m / 60);
    const r = Math.round(m - h * 60);
    return r ? `${h} h ${r} min` : `${h} h`;
  }
  const d = Math.round(m / 1440);
  return `${d} ${d === 1 ? "day" : "days"}`;
}

/** A tile's value in its own unit, split into the number and a small unit beside it. */
export function shown(t: Pick<Tile, "id" | "value">, currency: string): { v: string; unit?: string } {
  if (t.value === null) return { v: "—" };
  const unit = METRICS[t.id].unit;
  if (unit === "money") return { v: money(t.value, currency) };
  if (unit === "pct") return { v: pct(t.value, t.value > 0 && t.value < 0.1 ? 1 : 0) };
  if (unit === "duration") {
    const s = minutes(t.value);
    const m = s.match(/^(\d+) (min|h|days?)$/);
    return m ? { v: m[1]!, unit: m[2] } : { v: s };
  }
  if (unit === "days") return { v: t.value.toFixed(t.value < 10 ? 1 : 0), unit: "days" };
  return { v: count(t.value) };
}

const MOVE_WORDS: Partial<Record<MetricId, [string, string]>> = {
  new_leads: ["New leads are up", "New leads are down"],
  contacted: ["More leads are being contacted", "Fewer leads are being contacted"],
  reply_rate: ["Replies are up", "Replies are down"],
  speed_to_lead: ["First contact is slower", "First contact is faster"],
  won: ["Wins are up", "Wins are down"],
  win_rate: ["More leads are being won", "Fewer leads are being won"],
  revenue_won: ["Revenue is up", "Revenue is down"],
  ontime: ["Follow-ups are more on time", "Follow-ups are slipping"],
  calls_held: ["More calls are happening", "Fewer calls are happening"],
};

/** The size of a move, comparable across units: percent changes as they are, points ×2 (a 5-point move is big). */
function size(t: Tile): number {
  if (t.value === null || t.previous === null || !t.trend || t.trend.dir === "flat") return 0;
  const kind = METRICS[t.id].trendKind;
  if (kind === "pts") return Math.abs(t.value - t.previous) * 200;
  return t.previous ? Math.abs((t.value - t.previous) / t.previous) * 100 : 0;
}

/** Under this many new leads in the range, the headline says it's early days rather than read a trend. */
export const EARLY_DAYS = 30;

/** The period in words, from the range picked ("this month" on the 3rd is still a month). */
export type Period = "day" | "week" | "month" | "quarter";
export function headline(tiles: Tile[], period: Period): { title: string; sub: string | null } {
  const moves = tiles.filter((t) => MOVE_WORDS[t.id] && size(t) >= 5).sort((a, b) => size(b) - size(a));
  const good = moves.filter((t) => t.trend!.tone === "good");
  const bad = moves.filter((t) => t.trend!.tone === "bad");
  const words = (t: Tile) => MOVE_WORDS[t.id]![t.trend!.dir === "up" ? 0 : 1];
  const leads = tiles.find((t) => t.id === "new_leads")?.value ?? 0;
  const won = tiles.find((t) => t.id === "won")?.value ?? 0;
  const sub = `${count(leads)} new ${leads === 1 ? "lead" : "leads"} and ${count(won)} won.`;
  // 8D spec §5: on thin data, no trend claims ("A steady month" for 8 leads over-claims).
  if (leads > 0 && leads < EARLY_DAYS)
    return {
      title: "Early days.",
      sub: `${sub} Trends start to mean something from about ${EARLY_DAYS} leads.`,
    };
  if (!moves.length) return { title: leads ? `A steady ${period}.` : `A quiet ${period}.`, sub };
  // All the good moves against all the bad ones; the headline leads with the biggest on the side that wins.
  const weight = (xs: Tile[]) => xs.reduce((a, x) => a + size(x), 0);
  if (weight(good) >= weight(bad))
    return { title: `A good ${period}. ${words(good[0]!)}.`, sub: bad[0] ? `${sub} ${words(bad[0])}.` : sub };
  return {
    title: `A harder ${period}. ${words(bad[0]!)}.`,
    sub: good[0] ? `${sub} ${words(good[0])}.` : sub,
  };
}

/** How a rep's own numbers read in a sentence: the thing that moved, said the short way. */
const REP_WORDS: Partial<Record<MetricId, string>> = {
  new_leads: "new leads",
  contacted: "contact",
  reply_rate: "replies",
  speed_to_lead: "speed",
  won: "wins",
  win_rate: "win rate",
  revenue_won: "revenue",
  calls_held: "calls",
  ontime: "follow-ups on time",
};
const listed = (xs: string[]) =>
  xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

/**
 * The rep view's line under "Your October, so far" (canvas Rep): what's ahead of the period before and what's behind,
 * in the rep's own terms, then their follow-ups. No trend talk under 30 new leads (the same rule as the headline).
 */
export function repLine(tiles: Tile[], overdue: number): string {
  const leads = tiles.find((x) => x.id === "new_leads")?.value ?? null;
  const thin = leads !== null && leads < EARLY_DAYS;
  const moved = thin ? [] : tiles.filter((x) => REP_WORDS[x.id] && size(x) >= 5);
  // Nothing to compare with at all (compare is off, or nothing before): no claim about the period before.
  const compared = tiles.some((x) => x.trend);
  const ahead = moved.filter((x) => x.trend!.tone === "good").map((x) => REP_WORDS[x.id]!);
  const behind = moved.filter((x) => x.trend!.tone === "bad").map((x) => REP_WORDS[x.id]!);
  const verb = (xs: string[]) => (xs.length === 1 && !xs[0]!.endsWith("s") ? "is" : "are");
  const trendWords =
    thin || !compared
      ? ""
      : ahead.length
        ? `You’re ahead of the period before on ${listed(ahead)}${behind.length ? `; ${listed(behind)} ${verb(behind)} behind` : ""}. `
        : behind.length
          ? `${cap(listed(behind))} ${verb(behind)} behind the period before. `
          : "Much like the period before. ";
  const follow = overdue
    ? `${count(overdue)} ${overdue === 1 ? "follow-up is" : "follow-ups are"} overdue.`
    : "Every follow-up is on time.";
  return `${trendWords}${follow}`;
}
