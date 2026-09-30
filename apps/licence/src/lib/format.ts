import { formatMoney, inr } from "./money";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2027-03-12" → "12 Mar 2027" */
export const day = (d: string) =>
  `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
/** "2026-10-14" → "14 Oct" */
export const dayShort = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
/** An instant, in the reader's own time: "28 Sep, 09:12". */
export function when(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${hh}:${mm}`;
}
/** "2026-09" → "Sep" or "September 2026" */
export const month = (ym: string, long = false) => {
  const m = Number(ym.slice(5, 7)) - 1;
  return long ? `${LONG[m]} ${ym.slice(0, 4)}` : MONTHS[m]!;
};

/** How long ago, briefly: "just now", "12 min ago", "2 h ago", "9 days ago". */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 48 * 3600) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} days ago`;
}

const PER: Record<number, string> = { 1: "a month", 3: "a quarter", 12: "a year" };
export const perWords = (periodMonths: number) => PER[periodMonths] ?? "";

type Priced = {
  type: "subscription" | "perpetual" | "trial";
  price: { currency: string; amount: number; periodMonths: number } | null;
  monthlyInr: number | null;
};
/** The Plan and price cell: native first, with ≈ rupees when it isn't plain monthly rupees (the canvas's planOf). */
export function planOf(c: Priced, rates: Record<string, number>): { main: string; sub: string } {
  const p = c.price;
  if (!p) return { main: "No price", sub: "" };
  const native = formatMoney(p.amount, p.currency);
  if (c.type === "trial") return { main: "Trial", sub: `then ${native} ${perWords(p.periodMonths)}` };
  if (!p.periodMonths) {
    const r = rates[p.currency];
    return {
      main: `${native} once`,
      sub: `perpetual${p.currency !== "INR" && r ? ` · ≈ ${inr(p.amount * r)}` : ""}`,
    };
  }
  const main = `${native} ${perWords(p.periodMonths)}`;
  if (p.currency === "INR" && p.periodMonths === 1) return { main, sub: "subscription" };
  return { main, sub: c.monthlyInr ? `≈ ${inr(c.monthlyInr)} a month` : "no rate for this currency yet" };
}
