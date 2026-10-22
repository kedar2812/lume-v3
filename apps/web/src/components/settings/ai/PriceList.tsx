"use client";
import { profileProblem, type AiProfile } from "@lume/core/shared";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/Button";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { SPRINGS, toMotion } from "@/lib/motion";
import { parseAmount } from "@/lib/money-input";
import s from "./ai.module.css";

type Price = AiProfile["knows"]["prices"][number];
/** A row as it's being typed: the amount stays words until it's read. */
export type PriceDraft = Omit<Price, "price"> & { amount: string };

/** Grouped the way the currency reads (Indian lakh grouping for INR), as Goals shows a target. */
const grouped = (v: number, currency: string) =>
  v.toLocaleString(currency === "INR" ? "en-IN" : "en-US", { maximumFractionDigits: 2 });

export function draftsOf(prices: Price[], currency: string): PriceDraft[] {
  return prices.map(({ price, ...p }) => ({ ...p, amount: grouped(price, currency) }));
}

/** A row's problem in words, the API's own where it has them (core's profileProblem), or null. */
function rowProblem(d: PriceDraft): string | null {
  if (!d.item.trim()) return "Each price needs what it's for.";
  if (!d.amount.trim()) return "Each price needs its amount.";
  const a = parseAmount(d.amount);
  if ("error" in a) return /^\s*-/.test(d.amount) ? "A price can't be below zero." : a.error;
  const price = {
    id: d.id,
    item: d.item.trim(),
    price: a.value ?? 0,
    unit: d.unit.trim(),
    notes: d.notes.trim(),
  };
  return profileProblem({ knows: { prices: [price] } });
}

/** The prices to save, or the first row's problem. */
export function pricesOf(drafts: PriceDraft[]): { prices: Price[] } | { problem: string } {
  const prices: Price[] = [];
  for (const d of drafts) {
    const problem = rowProblem(d);
    if (problem) return { problem };
    const a = parseAmount(d.amount);
    prices.push({
      id: d.id,
      item: d.item.trim(),
      price: "value" in a ? (a.value ?? 0) : 0,
      unit: d.unit.trim(),
      notes: d.notes.trim(),
    });
  }
  return { prices };
}

/**
 * Settings → LUME AI's price list (Autopilot spec 2026-10-19 §5, §11): what each thing costs, in the business currency.
 * Structured rows, never free text, so a price LUME AI quotes can always be checked against one of them.
 */
export function PriceList({
  rows,
  currency,
  onChange,
}: {
  rows: PriceDraft[];
  currency: string;
  onChange(rows: PriceDraft[]): void;
}) {
  const reduce = !!useReducedMotion();
  const set = (i: number, patch: Partial<PriceDraft>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  // A row only says what's wrong once something's been typed in it (a new, empty row isn't scolded).
  const shown = (d: PriceDraft) => (d.item || d.amount ? rowProblem(d) : null);

  return (
    <div className={s.prices}>
      {rows.length === 0 && (
        <p className={s.empty}>No prices yet. LUME AI never quotes a price that isn&apos;t here.</p>
      )}
      <AnimatePresence initial={false}>
        {rows.map((d, i) => {
          const name = d.item.trim() || `price ${i + 1}`;
          const problem = shown(d);
          const amountBad = problem !== null && problem !== "Each price needs what it's for.";
          return (
            <motion.div
              key={d.id}
              role="group"
              aria-label={d.item.trim() || `Price ${i + 1}`}
              className={s.priceRow}
              layout={!reduce}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0, marginBottom: -10 }}
              transition={toMotion(SPRINGS.default)}
            >
              <input
                className={s.input}
                aria-label={`What ${name} is for`}
                placeholder="What it's for"
                maxLength={120}
                value={d.item}
                onChange={(e) => set(i, { item: e.target.value })}
              />
              <MoneyInput
                size="sm"
                currency={currency}
                amount={d.amount}
                aria-label={`Price for ${name}`}
                {...(amountBad ? { "aria-invalid": true } : {})}
                onChange={(amount) => set(i, { amount })}
              />
              <input
                className={s.input}
                aria-label={`Unit for ${name}`}
                placeholder="per visit"
                maxLength={40}
                value={d.unit}
                onChange={(e) => set(i, { unit: e.target.value })}
              />
              <button
                type="button"
                className={s.remove}
                aria-label={`Remove ${name}`}
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
              <input
                className={`${s.input} ${s.notes}`}
                aria-label={`Notes for ${name}`}
                placeholder="Notes LUME AI should know (optional)"
                maxLength={300}
                value={d.notes}
                onChange={(e) => set(i, { notes: e.target.value })}
              />
              {problem && (
                <p role="alert" className={s.rowProblem}>
                  {problem}
                </p>
              )}
            </motion.div>
          );
        })}
      </AnimatePresence>
      <Button
        size="sm"
        variant="secondary"
        disabled={rows.length >= 200}
        onClick={() =>
          onChange([...rows, { id: crypto.randomUUID(), item: "", amount: "", unit: "", notes: "" }])
        }
      >
        Add a price
      </Button>
    </div>
  );
}
