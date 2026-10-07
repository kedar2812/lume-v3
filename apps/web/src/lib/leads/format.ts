import { timeOf } from "@/lib/dates";
import type { Catalog, FieldDefView } from "./types";

export function formatMoney(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "";
  const whole = Number.isInteger(value);
  // Rupees grouped in lakhs (1,02,300), as Analytics and Goals read them; every other currency in thousands.
  const n = new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
  return `${currency} ${n}`;
}

const DAY = 86_400;
/**
 * "Sep 1" / "Sep 1, 2025": month first, as everywhere in LUME, on the person's clock (`tz`; UTC for a date that
 * has no time). en-US spells the months the same on every runtime (en-GB's "Sept" varies).
 */
export const shortDate = (d: Date, withYear: boolean, tz = "UTC"): string =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  }).format(d);
const yearIn = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(d);
/** "3h ago", "2d ago", then a date (on the person's clock) once it's more than a week old. */
export function relativeTime(iso: string, now: Date = new Date(), tz = "UTC"): string {
  const t = new Date(iso);
  const s = Math.round((now.getTime() - t.getTime()) / 1000);
  if (s < 60) return "just now"; // includes a clock slightly ahead of this one
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < DAY) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * DAY) return `${Math.floor(s / DAY)}d ago`;
  return shortDate(t, yearIn(t, tz) !== yearIn(now, tz), tz);
}

export const stageOf = (cat: Catalog, id: string | null | undefined) =>
  cat.pipelines.flatMap((p) => p.stages).find((s) => s.id === id);

export const personName = (cat: Catalog, id: string | null | undefined): string =>
  id ? (cat.people.find((p) => p.id === id)?.name ?? "Someone who left") : "Unassigned";

const dateText = (iso: string) => shortDate(new Date(`${iso.slice(0, 10)}T00:00:00Z`), true);

/** Any field value as the text a person reads: options by label, people by name, Yes/No, dates in words (in `tz`). */
export function fieldText(value: unknown, def: FieldDefView, cat: Catalog, tz = "UTC"): string {
  if (value === null || value === undefined || value === "") return "";
  const label = (id: unknown) => def.options.find((o) => o.id === id)?.label ?? "";
  switch (def.type) {
    case "select":
      return label(value);
    case "multi_select":
      return Array.isArray(value) ? value.map(label).filter(Boolean).join(", ") : "";
    case "boolean":
      return value ? "Yes" : "No";
    case "user":
      return personName(cat, String(value));
    case "currency":
      return formatMoney(Number(value), cat.currency);
    case "date":
      return dateText(String(value));
    case "datetime": {
      const d = new Date(String(value));
      return Number.isNaN(d.getTime()) ? String(value) : `${shortDate(d, true, tz)}, ${timeOf(d, tz)}`;
    }
    default:
      return String(value);
  }
}
