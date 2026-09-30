import type { AClient } from "./analytics";

/**
 * The approved canvas's fictional clients (the Licensing screens, final), as the analytics read them. Every
 * number the canvas shows comes from this list, so the analytics are tested against the design itself.
 */
export const CANVAS_NOW = new Date("2026-09-29T12:00:00Z");
export const CANVAS_RATES = { INR: 1, USD: 88.4, AED: 24.07, GBP: 118.6, EUR: 103.2, SGD: 68.9, AUD: 58.2 };
export const CANVAS_LIST_PRICE = 3999;

type Row = [
  name: string,
  country: string,
  region: string | null,
  currency: string,
  amount: number,
  period: number | null,
  from: string,
  source: AClient["source"],
  to?: string,
  was?: { amount: number; until: string },
];
const ROWS: Row[] = [
  ["Brightpath Studio", "IN", "MH", "INR", 59988, 12, "2026-03", "referrals"],
  ["Harbour Clinic", "IN", "KA", "INR", 2999, 1, "2026-07", "demo"],
  ["Northwind Coaching", "GB", null, "GBP", 1200, 0, "2025-11", "website"],
  [
    "Oakline Realty",
    "AE",
    null,
    "AED",
    450,
    1,
    "2026-02",
    "referrals",
    undefined,
    { amount: 350, until: "2026-09" },
  ],
  ["Cedar & Co Salon", "IN", "DL", "INR", 3999, null, "2026-09", "instagram"],
  ["Summit Fitness", "IN", "MH", "INR", 41988, 12, "2026-06", "demo"],
  ["Bluebell Dental", "IN", "GJ", "INR", 2499, 1, "2025-12", "instagram", "2026-09"],
  ["Meridian Tutors", "US", null, "USD", 948, 12, "2026-01", "website"],
  ["Lotus Wellness", "IN", "TN", "INR", 3999, 1, "2026-08", "referrals"],
  ["Kestrel Logistics", "SG", null, "SGD", 120, 1, "2026-05", "website"],
  ["Saffron Events", "IN", "MH", "INR", 5499, 1, "2026-04", "referrals"],
  ["Pinecrest Academy", "IN", "TS", "INR", 8997, 3, "2026-04", "demo"],
  ["Riverstone Interiors", "IN", "KA", "INR", 3999, 1, "2026-09", "referrals"],
  ["Fjord Analytics", "DE", null, "EUR", 59, 1, "2026-08", "website"],
  ["Coral Bay Physio", "AU", null, "AUD", 99, 1, "2026-09", "demo"],
];
const at = (month: string, day: number) => new Date(`${month}-${String(day).padStart(2, "0")}T09:00:00Z`);

function client(
  [name, country, region, currency, amount, period, from, source, to, was]: Row,
  i: number,
): AClient {
  const created = at(from, 10);
  const prices = was
    ? [
        { currency, amount: was.amount, periodMonths: period ?? 1, from: created },
        { currency, amount, periodMonths: period ?? 1, from: at(was.until, 5) },
      ]
    : [{ currency, amount, periodMonths: period ?? 1, from: created }];
  return {
    id: `c${i + 1}`,
    name,
    country,
    region,
    source,
    type: period === null ? "trial" : period === 0 ? "perpetual" : "subscription",
    createdAt: created,
    payingSince: period ? created : null,
    endedAt: to ? at(to, 20) : null,
    trialEnds: period === null ? "2026-10-14" : null,
    trialStarted: period === null,
    prices,
  };
}

/** "Growing" (the canvas's default). */
export const CANVAS_CLIENTS: AClient[] = ROWS.map(client);

/** "Declining": September loses two clients abroad and gains no one. */
export const CANVAS_DECLINING: AClient[] = CANVAS_CLIENTS.filter(
  (c) => !(c.createdAt >= at("2026-09", 1) && c.type !== "trial"),
).map((c) =>
  c.name === "Oakline Realty" || c.name === "Kestrel Logistics" ? { ...c, endedAt: at("2026-09", 12) } : c,
);
