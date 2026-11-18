import { costOf, RATE_CARDS, type MetaCategory, type TemplateCost } from "@lume/core";
import { schema } from "@lume/db";
import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { rateFor } from "../../money/fx-cache";

export type Pricer = (countryIso: string | null, category: MetaCategory) => TemplateCost | null;

/**
 * What WhatsApp charges for a template, in the business currency (owner 2026-11-18: it stayed in rupees whatever
 * Settings said). Meta's own card when it bills in that currency; otherwise its dollar card at today's rate; with no
 * rate kept yet (one is fetched behind, never while a transaction waits) or none to be had, in dollars, as Meta's
 * card says it, rather than a guess. The business currency is read once, so a
 * run over many leads prices them all with one look.
 */
export async function pricer(req: FastifyRequest, d: AppDeps): Promise<Pricer> {
  const [s] = await req.db.select({ currency: schema.settings.currency }).from(schema.settings);
  const want = (s?.currency ?? "USD").toUpperCase();
  const rate = RATE_CARDS[want] ? 1 : rateFor(d.rates, "USD", want);
  return (countryIso, category) => {
    const c = costOf(countryIso, category, want);
    if (!c || c.currency === want || !rate) return c;
    return { amount: Math.round(c.amount * rate * 10_000) / 10_000, currency: want, asOf: c.asOf };
  };
}
