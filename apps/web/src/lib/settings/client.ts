"use client";
import { api } from "@/lib/api";

export type BusinessSettings = {
  businessName: string;
  timezone: string;
  currency: string;
  defaultCountry: string;
  weekStart: number;
  industryPreset: string;
};
export type CurrencyQuote = {
  from: string;
  to: string;
  rate: number;
  asOf: string;
  source: string;
  affected: { leads: number; products: number; customFields: number };
};

/** Every Settings call the screens make. Each returns ApiResult, so a 403 can be told apart. */
export const settingsClient = {
  get: () => api.get<BusinessSettings>("/api/v1/settings"),
  patch: (patch: Partial<Omit<BusinessSettings, "currency" | "industryPreset">>) =>
    api.patch<BusinessSettings>("/api/v1/settings", patch),
  quoteCurrency: (to: string) =>
    api.get<CurrencyQuote>(`/api/v1/settings/currency/quote?to=${encodeURIComponent(to)}`),
  switchCurrency: (input: { from: string; to: string; rate: number }) =>
    api.post<{ currency: string; converted: { leads: number; products: number } }>(
      "/api/v1/settings/currency",
      input,
    ),
};
