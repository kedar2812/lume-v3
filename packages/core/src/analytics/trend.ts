/**
 * One rule for every change LUME shows (the owner, 2026-09-29; analytics spec §2, the licence server keeps its own copy):
 * - the arrow follows the direction of the change; the colour follows whether that direction is good for
 *   this number (fewer clients lost is good: a green arrow pointing down);
 * - the decision is made on the rounded number that's shown, so "+0.0%" never appears: a change that rounds
 *   to zero is "No change", grey, with a flat line;
 * - the number always carries its own + or − (U+2212), so colour is never the only signal;
 * - nothing to compare with (last month was 0) is "New", never an infinite percentage.
 */
export type Trend = { dir: "up" | "down" | "flat"; tone: "good" | "bad" | "flat"; text: string };
export type TrendOptions = {
  /** pct: a relative change; pts: two ratios, in percentage points; abs: the plain difference. */
  kind?: "pct" | "pts" | "abs";
  good?: "up" | "down";
  /** What it's compared with ("Aug"): " vs Aug". */
  vs?: string;
  /** abs only: decimal places shown. */
  places?: number;
  /** abs only: how the size of the change reads ("₹2,407"). */
  format?: (n: number) => string;
};

export const MINUS = "−";

/** A number with its thousands grouped like every other number LUME shows: 199,900.0. */
const grouped = (n: number, places: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places });

export function trend(now: number, before: number, o: TrendOptions = {}): Trend {
  const good = o.good ?? "up";
  const kind = o.kind ?? "pct";
  const vs = o.vs ? ` vs ${o.vs}` : "";
  const flat: Trend = { dir: "flat", tone: "flat", text: `No change${vs}` };
  if (!Number.isFinite(now) || !Number.isFinite(before)) return flat;
  let diff: number;
  if (kind === "pct") {
    if (!(before > 0))
      return now > 0 ? { dir: "up", tone: good === "up" ? "good" : "bad", text: `New${vs}` } : flat;
    diff = ((now - before) / before) * 100;
  } else if (kind === "pts") diff = (now - before) * 100;
  else diff = now - before;
  const places = kind === "abs" ? (o.places ?? 0) : 1;
  const scale = 10 ** places;
  const shown = Math.round(Math.abs(diff) * scale) / scale;
  if (shown === 0) return flat;
  const dir = diff > 0 ? "up" : "down";
  const tone = (dir === "up") === (good === "up") ? "good" : "bad";
  const body =
    kind === "pct"
      ? `${grouped(shown, 1)}%`
      : kind === "pts"
        ? `${grouped(shown, 1)} pts`
        : o.format
          ? o.format(shown)
          : grouped(shown, places);
  return { dir, tone, text: `${dir === "up" ? "+" : MINUS}${body}${vs}` };
}

/** A value with its own sign: "+43.9", "−12.4", and "0.0" with none. */
export function signed(v: number, places: number): string {
  const scale = 10 ** places;
  const r = Math.round(Math.abs(v) * scale) / scale;
  return `${r === 0 ? "" : v > 0 ? "+" : MINUS}${r.toFixed(places)}`;
}

/** The jagged "trending" arrows (the canvas's), in a 16×16 box. */
export const ARROWS = {
  up: "M1.5 12l4.5-4.5 3 3 5.5-5.5M10 5h4.5v4.5",
  down: "M1.5 4.5L6 9l3-3 5.5 5.5M10 11.5h4.5V7",
  flat: "M2 8h12",
} as const;
