import type { ApiResult } from "@/lib/api";
import type { Catalog } from "./types";

type Failure = Extract<ApiResult<unknown>, { ok: false }>;

/** API property → field key, where they differ. */
const API_TO_FIELD: Record<string, string> = { leadCreatedAt: "lead_created_at", productId: "product" };
const CORE_MESSAGE: Record<string, string> = {
  name: "Give the lead a name",
  email: "Enter a valid email address",
  instagram: "Use letters, numbers, dots and underscores (up to 30)",
  phone: "Enter a phone number",
  value: "Enter an amount from 0 up to 1 trillion",
  currency: "Use a three-letter currency code",
  lead_created_at: "Enter a real date",
};

function customMessage(key: string, apiMessage: string, cat: Catalog): string {
  const def = cat.fields.find((f) => f.key === key);
  if (!def) return "Check this value";
  switch (def.type) {
    case "select":
    case "multi_select":
      return `That isn’t one of the ${def.label} options`;
    case "number":
    case "currency":
      return /decimal/i.test(apiMessage) ? "Use at most two decimals" : "Enter a number";
    case "date":
    case "datetime":
      return "Enter a real date";
    case "email":
      return "Enter a valid email address";
    case "url":
      return "Enter a full web address, starting with https://";
    case "user":
      return "Pick someone who works here";
    default:
      return `Check ${def.label}`;
  }
}

/**
 * The API's field errors as plain words, by field key, so each can sit under its own field. Two shapes
 * arrive: schema errors ([{ instancePath: "/email" }]) and custom-field errors ([{ path: "struggles" }]).
 */
export function fieldErrors(r: Failure, cat: Catalog): Record<string, string> {
  const out: Record<string, string> = {};
  const details = Array.isArray(r.details) ? (r.details as Record<string, unknown>[]) : [];
  if (r.code === "VALIDATION_FAILED") {
    for (const d of details) {
      const parts = String(d.instancePath ?? "")
        .split("/")
        .filter(Boolean);
      if (!parts[0]) continue;
      if (parts[0] === "custom" && parts[1])
        out[parts[1]] ??= customMessage(parts[1], String(d.message ?? ""), cat);
      else {
        const key = API_TO_FIELD[parts[0]] ?? parts[0];
        out[key] ??= CORE_MESSAGE[key] ?? "Check this value";
      }
    }
  }
  if (r.code === "INVALID_CUSTOM_FIELDS") {
    for (const d of details) {
      const key = String(d.path ?? "").split(".")[0];
      if (key) out[key] ??= customMessage(key, String(d.message ?? ""), cat);
    }
  }
  if (r.code === "UNKNOWN_USER") {
    for (const f of cat.fields.filter((x) => x.type === "user")) out[f.key] ??= "Pick someone who works here";
  }
  return out;
}
