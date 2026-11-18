import { MARKET_OF, RATE_CARD_DATE, RATE_CARDS } from "./rate-card";
import type { MetaCategory } from "./templates";

export type TemplateCost = { amount: number; currency: string; asOf: string };

/** Meta's market for a country: its own, or the region it's charged as ("Rest of Africa"…), else "Other". */
export function marketOf(countryIso: string): string {
  return MARKET_OF[countryIso.toUpperCase()] ?? "Other";
}

const COLUMN: Record<MetaCategory | "AUTHENTICATION", 0 | 1 | 2> = {
  MARKETING: 0,
  UTILITY: 1,
  AUTHENTICATION: 2,
};

/**
 * What WhatsApp charges for one template message, from Meta's rate cards (rate-card.ts; the business pays Meta
 * directly, so LUME only says "about"): by the lead's country and the template's category (owner 2026-11-18: it was
 * India's marketing rate in rupees for everyone). In the given currency when Meta bills in it, as its own card says
 * (a local card isn't the dollar rate converted); otherwise in dollars, for LUME to convert. The list rate, the most
 * a message costs: Meta's volume discounts only start in the hundreds of thousands a month. Null with no country.
 */
export function costOf(
  countryIso: string | null,
  category: MetaCategory | "AUTHENTICATION",
  currency = "USD",
): TemplateCost | null {
  if (!countryIso) return null;
  const card = RATE_CARDS[currency.toUpperCase()] ? currency.toUpperCase() : "USD";
  const row = RATE_CARDS[card]![marketOf(countryIso)];
  if (!row) return null;
  return { amount: row[COLUMN[category]], currency: card, asOf: RATE_CARD_DATE };
}
