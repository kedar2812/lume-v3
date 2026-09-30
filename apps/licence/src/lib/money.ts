/**
 * Money (spec §4.6). Prices are kept in the client's own currency; everything summed is in rupees, at today's
 * rates (so growth isn't exchange-rate noise). A payment keeps the rate of the day it was marked paid.
 * A missing rate is said, never invented: these return null.
 */
export type Rates = Readonly<Record<string, number>>;
export type Price = { currency: string; amount: number; periodMonths: number };

/** Rupees for one unit of `currency`, or null when LUME has no rate for it. */
export function rateOf(rates: Rates, currency: string): number | null {
  if (currency === "INR") return 1;
  const r = rates[currency];
  return typeof r === "number" && r > 0 ? r : null;
}

export function toInr(amount: number, currency: string, rates: Rates): number | null {
  const r = rateOf(rates, currency);
  return r === null ? null : amount * r;
}

/** A price's monthly revenue in rupees: a yearly price is a twelfth a month, a quarterly one a third; one-time is 0. */
export function monthlyInr(p: Price, rates: Rates): number | null {
  if (!p.periodMonths) return 0;
  const inr = toInr(p.amount, p.currency, rates);
  return inr === null ? null : inr / p.periodMonths;
}

/** A typed price moved to another currency at today's rate, to a whole unit (round it however you like). */
export function convertAmount(amount: number, from: string, to: string, rates: Rates): number | null {
  if (!(amount > 0) || from === to) return amount;
  const a = rateOf(rates, from);
  const b = rateOf(rates, to);
  return a === null || b === null ? null : Math.round((amount * a) / b);
}

const SYMBOL: Record<string, string> = { INR: "₹", USD: "$", GBP: "£", EUR: "€", SGD: "S$", AUD: "A$" };

/** Money in its own currency: "₹2,59,988", "AED 450", "$948", "€59.50". */
export function formatMoney(amount: number, currency: string): string {
  const whole = Number.isInteger(Math.round(amount * 100) / 100) && Math.round(amount * 100) % 100 === 0;
  const n = amount.toLocaleString(currency === "INR" ? "en-IN" : "en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  });
  const sym = SYMBOL[currency];
  return sym ? `${sym}${n}` : `${currency} ${n}`;
}

/** Rupees, rounded to the rupee: "₹65,927". */
export const inr = (v: number): string => `₹${Math.round(v).toLocaleString("en-IN")}`;
/** Short rupees for axes and chips: "₹66k", "₹1.2L". */
export function shortInr(v: number): string {
  if (v >= 100000) return `₹${(v / 100000).toFixed(1).replace(/\.0$/, "")}L`;
  if (v >= 1000) return `₹${(v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return `₹${Math.round(v)}`;
}
