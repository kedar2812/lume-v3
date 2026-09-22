import { z } from "zod";
import { normalizePhone } from "./phone";

export const FIELD_TYPES = [
  "text",
  "long_text",
  "number",
  "currency",
  "date",
  "datetime",
  "boolean",
  "select",
  "multi_select",
  "phone",
  "email",
  "url",
  "user",
  "instagram",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export type FieldOption = { id: string; label: string; color?: string; archived?: boolean };
export type FieldDef = {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  options: FieldOption[];
  isCore: boolean;
  isRequired: boolean;
  archived: boolean;
};

export const normalizeInstagram = (h: string): string => h.trim().replace(/^@/, "").toLowerCase();
export const INSTAGRAM_RE = /^@?[A-Za-z0-9._]{1,30}$/;

const cents = (v: number) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;

function valueSchema(def: FieldDef, ctx: { defaultCountry: string | null }): z.ZodType {
  const live = def.options.filter((o) => !o.archived).map((o) => o.id);
  switch (def.type) {
    case "text":
      return z.string().trim().min(1).max(500);
    case "long_text":
      return z.string().trim().min(1).max(10_000);
    case "number":
      return z.number().finite();
    case "currency":
      return z.number().finite().nonnegative().max(1e12).refine(cents, "at most two decimals");
    case "date":
      return z.iso.date();
    case "datetime":
      return z.iso.datetime({ offset: true });
    case "boolean":
      return z.boolean();
    case "select":
      return z.string().refine((v) => live.includes(v), "unknown option");
    case "multi_select":
      return z
        .array(z.string().refine((v) => live.includes(v), "unknown option"))
        .max(50)
        .refine((a) => new Set(a).size === a.length, "duplicate option");
    case "phone":
      return z.string().transform((v, c) => {
        const p = normalizePhone(v, ctx.defaultCountry);
        if (p.status !== "valid") {
          c.addIssue({ code: "custom", message: "not a valid phone number" });
          return z.NEVER;
        }
        return p.e164!;
      });
    case "email":
      return z
        .email()
        .max(254)
        .transform((v) => v.toLowerCase());
    case "url":
      return z.url({ protocol: /^https?$/ }).max(2000);
    case "user":
      return z.uuid(); // existence and status are checked by the service
    case "instagram":
      return z.string().regex(INSTAGRAM_RE).transform(normalizeInstagram);
  }
}

/**
 * Report §6: custom-field writes are validated against the live definitions. Archived fields and core
 * fields are not writable here (core fields are real columns); unknown keys are rejected. `null`
 * clears an optional field. `create` also requires every required field.
 */
export function buildCustomFieldSchemas(defs: FieldDef[], ctx: { defaultCountry: string | null }) {
  const writable = defs.filter((d) => !d.isCore && !d.archived);
  const patchShape: Record<string, z.ZodType> = {};
  const createShape: Record<string, z.ZodType> = {};
  for (const d of writable) {
    const v = valueSchema(d, ctx);
    patchShape[d.key] = d.isRequired ? v.optional() : v.nullable().optional();
    createShape[d.key] = d.isRequired ? v : v.nullable().optional();
  }
  return {
    create: z.strictObject(createShape) as unknown as z.ZodType<Record<string, unknown>>,
    patch: z.strictObject(patchShape) as unknown as z.ZodType<Record<string, unknown>>,
  };
}
