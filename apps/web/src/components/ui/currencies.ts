"use client";
import { CURRENCIES, currencyCountry } from "@lume/core/shared";
import { fold, type ListItem } from "./SearchList";

export type Currency = { code: string; name: string; symbol: string; key: string };

let cached: Currency[] | null = null;
/** Every currency in use, with its English name and symbol from the browser's Intl data, by name. */
export function currencies(): Currency[] {
  if (cached) return cached;
  const names =
    typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "currency" }) : null;
  cached = CURRENCIES.map((code) => {
    const name = names?.of(code) ?? code;
    let symbol = code;
    try {
      symbol =
        new Intl.NumberFormat("en", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" })
          .formatToParts(0)
          .find((p) => p.type === "currency")?.value ?? code;
    } catch {
      // An engine without data for it: the code stands in.
    }
    return { code, name, symbol, key: fold(`${name} ${code}`) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return cached;
}

export const currencyName = (code: string) => currencies().find((c) => c.code === code)?.name ?? code;

/** Ranked for a query: code, then symbol, then name (word starts before anywhere). The current one first. */
export function searchCurrencies(query: string, current: string | null): ListItem[] {
  const all = currencies();
  const q = fold(query.trim());
  const item = (c: Currency): ListItem => ({
    id: c.code,
    label: c.name,
    detail: c.code,
    flag: currencyCountry(c.code),
  });
  if (!q) {
    const first = all.find((c) => c.code === current);
    return (first ? [first, ...all.filter((c) => c !== first)] : all).map(item);
  }
  const rank = (c: Currency) =>
    c.code.toLowerCase() === q
      ? 0
      : c.symbol.toLowerCase() === q
        ? 1
        : c.code.toLowerCase().startsWith(q)
          ? 2
          : c.key.startsWith(q)
            ? 3
            : c.key.split(/\s/).some((w) => w.startsWith(q))
              ? 4
              : 5;
  return all
    .filter((c) => c.key.includes(q) || c.symbol.toLowerCase() === q)
    .sort((a, b) => rank(a) - rank(b))
    .map(item);
}
