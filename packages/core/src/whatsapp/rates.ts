import type { MetaCategory } from "./templates";

export type TemplateCost = { amount: number; currency: string; asOf: string };

/**
 * What WhatsApp charges for one template message, by the lead's country and the template's category, from Meta's
 * published rate card (the business pays Meta directly; LUME only says "about"). Each rate carries the day it was
 * read. Only rates read from the card are here: a market or category without one says nothing rather than guess.
 * How to add a market: docs/runbooks/whatsapp.md.
 */
export const TEMPLATE_RATES: Record<string, Partial<Record<MetaCategory, TemplateCost>>> = {
  IN: { MARKETING: { amount: 0.86, currency: "INR", asOf: "2026-10-18" } },
};

export function costOf(countryIso: string | null, category: MetaCategory): TemplateCost | null {
  if (!countryIso) return null;
  return TEMPLATE_RATES[countryIso.toUpperCase()]?.[category] ?? null;
}
