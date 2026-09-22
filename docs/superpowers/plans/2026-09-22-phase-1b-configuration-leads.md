# Phase 1B — Configuration & Leads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything a business configures (pipelines, stages, fields, lost reasons, tags, products, per-role field access, industry presets) and the leads themselves: create, read, list/search, edit with optimistic concurrency, stage moves and assignment with history, notes and activities, masked contacts with a metered Reveal, bulk actions, duplicate warnings, and idempotent retries. Row-level security enforces lead scope, so no route and no raw SQL as `lume_app` can read an out-of-scope lead.

**Architecture:** Pure logic stays in `packages/core/src/leads/`: phone normalisation, masking, the custom-field schema builder, field-access merging, `canOnRecord` and the presets. Migrations add the configuration and lead tables, then force RLS on every lead table.

The API adds these pieces:
- **Field registry:** a per-app cache keyed by `settings.field_defs_version`.
- **Serializer:** one serializer that every lead-returning route uses, applying masking and field access.
- **Idempotency:** a plugin whose response record is written by a new `req.beforeCommit` hook inside the request transaction.
- **Feature modules:** `pipelines`, `fields`, `catalog` (lost reasons, tags, products) and `leads`.

Access follows three layers: the route guard (1A), a service check with `canOnRecord`, then RLS.

**Tech Stack:** as 1A, plus `libphonenumber-js` (max metadata) and Zod 4 in `@lume/core`.

**Specs:** `docs/superpowers/specs/2026-09-21-phase-1-identity-rbac-leads-design.md` (§1 decisions, §2 1B row, §3 Leads, §4 routes), `docs/LUME_PROJECT_REPORT.md` §4.4, §5.2, §5.3, §5.6, §6, §7.1, §7.4–7.5, §8.3–8.4, §12.2, §14.

## Global Constraints

- Everything from Plan 1A's Global Constraints applies: `main` only, the full gate before every commit (`scripts/dev.sh run bash -c 'pnpm lint && pnpm typecheck && pnpm test'`), push after every task and watch CI, host rules, and fail closed.
- **404, never 403, for a lead outside the caller's scope** (report §4.4). A lead that exists but isn't visible is indistinguishable from one that doesn't exist.
- **Masking:** without `leads.contact.full` on that lead, phone, email and Instagram are masked in *every* response (report §12.2). Masked roles cannot search by phone, email or Instagram (prevents enumeration). No endpoint returns more than 100 leads.
- **Field access:** a field `hidden` for the caller never appears in any response and cannot be written, filtered or revealed. A `view` field cannot be written.
- **No contact values** in audit diffs, activity payloads, logs or idempotency records of reveal responses.
- **History tables** (`lead_stage_history`, `lead_assignment_history`, `activities`) are insert-only for `lume_app`.
- Every mutation touching a lead bumps `leads.version`. `PATCH /leads/:id` requires `If-Match: <version>`: a missing header gets `428 PRECONDITION_REQUIRED`, a stale one gets `409 VERSION_CONFLICT`.
- `Idempotency-Key` is honoured on every authenticated POST/PATCH/PUT/DELETE except routes with `config.idempotent: false` (Reveal). It lasts 24 h; the same key with a different request gets `422 IDEMPOTENCY_MISMATCH`.
- Library pins: `libphonenumber-js@^1.13`, `zod@^4` in `@lume/core`.
- Commits end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Decisions this plan makes (the spec leaves them open)

1. **RLS on UPDATE:** `USING (visible)` plus `WITH CHECK (lume_user() IS NOT NULL)`. A caller may only update a lead they can see, but the result need not stay visible to them, which is what "assign my lead to someone else" requires. INSERT keeps `WITH CHECK (visible)`. There is no DELETE policy, so hard deletes by `lume_app` do nothing; leads are soft-deleted. Services still check the scoped write permission (`canOnRecord`) before every write.
2. **Duplicate detection across scopes** uses `lead_contact_keys (lead_id, kind, key_hash)`. It holds only SHA-256 hashes of normalised contact values, is maintained by a trigger on `leads`, and has no RLS, so "a lead with this phone already exists" works even when the caller can't see that lead. The owner's name is shown only when the caller can see the lead (report §8.3).
3. **Backups under forced RLS:** `pg_dump --enable-row-security`, plus a `FOR SELECT TO lume_readonly_backup USING (true)` policy on every RLS table. No role gets `BYPASSRLS`, so the 1A roles test still holds. Restores work because pg_dump emits `ENABLE/FORCE ROW LEVEL SECURITY` and policies after the data.
4. **Anything that must count every lead** (archiving a stage or pipeline) requires `leads.view` at scope `all`, otherwise `403 NEEDS_FULL_VISIBILITY`. Under RLS a narrower caller would see a partial count.
5. **Field `type` is immutable in 1B** (`400 TYPE_IMMUTABLE`). The guided migration comes later (report §6).
6. **Field access default is `edit`.** A role without a row for a field grants `edit`, and access across a user's roles is the widest. Nobody can grant a role wider field access than they hold themselves (owner exempt), matching the 1A escalation rule.
7. **Preset content** (Nupuur): the report's stages. `struggles` is a multi-select with six starter options (Confidence, Career direction, Relationships, Stress & anxiety, Health & habits, Productivity), all editable in Settings. `handled_by` is a user field. Lost reasons: Not interested, Price too high, No response, Bad timing, Chose someone else, Not a fit. **Tasneem to confirm the options and reasons (report §18 #7)**; changing them needs no code.
8. **Stage moves:** moving into a `lost` stage requires an active lost reason. `won` sets `won_at` and `lost` sets `lost_at`; moving back to `open` clears both. Required fields of the target stage must be filled (`422 REQUIRED_FIELDS`). Archiving a stage that has leads moves them to an **open** stage of the same pipeline, with history.
9. **Config reads** (`GET /pipelines`, `/fields`, `/lost-reasons`, `/tags`, `/products`) need `leads.view`. The field list omits fields hidden from the caller unless they hold `fields.manage`.

## File Map

| Path | Responsibility |
|---|---|
| `packages/core/src/leads/phone.ts` | normalise, format (report §8.4) |
| `packages/core/src/leads/mask.ts` | phone/email/Instagram masks |
| `packages/core/src/leads/custom-fields.ts` | types, runtime Zod schema builder |
| `packages/core/src/leads/field-access.ts` | widest-wins merge across roles |
| `packages/core/src/leads/presets.ts` | core fields + Coaching/General presets |
| `packages/core/src/rbac/engine.ts` | + `canOnRecord` |
| `packages/db/migrations/0008_configuration.sql`, `0009_leads.sql`, `0010_lead_rls.sql` | schema + RLS |
| `packages/db/src/schema/{types,config,leads}.ts` | Drizzle mirror |
| `packages/db/src/rls.test.ts` | RLS proven by raw SQL as `lume_app` |
| `apps/api/src/db/context.ts` | + `req.beforeCommit` |
| `apps/api/src/http/idempotency.ts` | Idempotency-Key replay |
| `apps/api/src/rbac/actor.ts` | + field access |
| `apps/api/src/leads/fields.ts` | field registry cache |
| `apps/api/src/modules/pipelines/{routes,service,seed}.ts` | pipelines, stages, preset seeding |
| `apps/api/src/modules/fields/{routes,service}.ts` | field definitions |
| `apps/api/src/modules/catalog/{routes,service}.ts` | lost reasons, tags, products |
| `apps/api/src/modules/roles/field-access.ts` | `PUT /roles/:id/field-access` |
| `apps/api/src/modules/leads/{routes,service,serialize,query,write,reveal,bulk,duplicates}.ts` | leads |
| `apps/worker/src/maintenance.ts` | hourly idempotency purge |
| `apps/api/test/{harness,probes,matrix.test}.ts` | fixtures, access table, scope test |
| `infra/scripts/backup.sh`, `infra/scripts/acceptance-1b.mjs` | backups under RLS, live acceptance |

---

### Task 1: Core leads library

**Files:**
- Create: `packages/core/src/leads/{phone,mask,custom-fields,field-access,presets}.ts`, `packages/core/src/leads/leads.test.ts`
- Modify: `packages/core/src/rbac/engine.ts`, `packages/core/src/rbac/rbac.test.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `normalizePhone(input: string | null | undefined, defaultCountry?: string | null): NormalizedPhone`, where `NormalizedPhone = { raw: string | null; e164: string | null; countryIso: string | null; status: PhoneStatus }` and `PhoneStatus = "valid" | "needs_country" | "invalid" | "missing"`
  - `formatPhone(e164: string): string`
  - `maskPhone(p: { e164: string | null; raw: string | null }): string`, `maskEmail(e: string): string`, `maskInstagram(h: string): string`
  - `FIELD_TYPES`, `type FieldType`, `type FieldOption = { id; label; color?; archived? }`, `type FieldDef = { id; key; label; type; options; isCore; isRequired; archived }`
  - `buildCustomFieldSchemas(defs: FieldDef[], ctx: { defaultCountry: string | null }): { create: z.ZodType<Record<string, unknown>>; patch: z.ZodType<Record<string, unknown>> }` (custom fields only)
  - `normalizeInstagram(h: string): string`
  - `type FieldAccess = "hidden" | "view" | "edit"`, `mergeFieldAccess(roleIds: string[], rows: { roleId; fieldId; access }[]): Map<string, FieldAccess>` (only non-`edit` results), `fieldAccessOf(map, fieldId): FieldAccess`
  - `canOnRecord(actor: Actor, key: PermissionKey, ownerId: string | null): boolean`
  - `CORE_FIELDS`, `CORE_FIELD_KEYS`, `PRESETS: Record<PresetKey, Preset>`, `type PresetKey = "coaching" | "general"`

- [ ] **Step 1: Dependencies**

Run:
```bash
scripts/dev.sh add --filter @lume/core libphonenumber-js@^1.13 zod@^4
```

- [ ] **Step 2: Write the failing tests**

`packages/core/src/leads/leads.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildCustomFieldSchemas, normalizeInstagram, type FieldDef } from "./custom-fields";
import { fieldAccessOf, mergeFieldAccess } from "./field-access";
import { maskEmail, maskInstagram, maskPhone } from "./mask";
import { formatPhone, normalizePhone } from "./phone";
import { CORE_FIELDS, CORE_FIELD_KEYS, PRESETS } from "./presets";

describe("phone normalisation (report §8.4: never guess silently)", () => {
  it.each([
    ["+971 50 123 4567", null, { e164: "+971501234567", countryIso: "AE", status: "valid" }],
    ["00971-50-123-4567", null, { e164: "+971501234567", countryIso: "AE", status: "valid" }],
    ["(050) 123 4567", "AE", { e164: "+971501234567", countryIso: "AE", status: "valid" }],
    ["+91 98765 43210", "AE", { e164: "+919876543210", countryIso: "IN", status: "valid" }],
    ["9876543210", null, { e164: null, countryIso: null, status: "needs_country" }],
    ["9876543210", "AE", { e164: null, countryIso: null, status: "needs_country" }],
    ["+971 12", null, { e164: null, countryIso: null, status: "invalid" }],
    ["call me", "AE", { e164: null, countryIso: null, status: "invalid" }],
    ["   ", "AE", { e164: null, countryIso: null, status: "missing" }],
  ] as const)("%s (default %s)", (input, country, expected) => {
    expect(normalizePhone(input, country)).toMatchObject(expected);
  });

  it("keeps the raw value exactly as received", () => {
    expect(normalizePhone(" 050 123 4567 ", "AE").raw).toBe("050 123 4567");
    expect(normalizePhone(null).raw).toBeNull();
  });

  it("formats international for display", () => {
    expect(formatPhone("+971501234567")).toBe("+971 50 123 4567");
  });
});

describe("masking (spec §3 Leads)", () => {
  it("phone keeps the country code, two national digits and the last two", () => {
    expect(maskPhone({ e164: "+971501234567", raw: "0501234567" })).toBe("+971 50 ••• ••67");
    expect(maskPhone({ e164: null, raw: "98765 43210" })).toBe("••• ••10");
  });
  it("email keeps the first letter and the domain", () => {
    expect(maskEmail("asha.patel@gmail.com")).toBe("a•••@gmail.com");
    expect(maskEmail("x@y.co")).toBe("x•••@y.co");
  });
  it("instagram keeps the first and last character", () => {
    expect(maskInstagram("asha.k")).toBe("@a•••k");
    expect(maskInstagram("a")).toBe("@a•••");
  });
});

const defs: FieldDef[] = [
  { id: "f1", key: "struggles", label: "Struggles", type: "multi_select", isCore: false, isRequired: false, archived: false, options: [{ id: "o1", label: "Confidence" }, { id: "o2", label: "Career" }, { id: "o3", label: "Old", archived: true }] },
  { id: "f2", key: "budget", label: "Budget", type: "currency", isCore: false, isRequired: true, archived: false, options: [] },
  { id: "f3", key: "call_on", label: "Call on", type: "date", isCore: false, isRequired: false, archived: false, options: [] },
  { id: "f4", key: "alt_phone", label: "Alt phone", type: "phone", isCore: false, isRequired: false, archived: false, options: [] },
  { id: "f5", key: "legacy", label: "Legacy", type: "text", isCore: false, isRequired: false, archived: true, options: [] },
  { id: "f6", key: "handled_by", label: "Handled by", type: "user", isCore: false, isRequired: false, archived: false, options: [] },
  { id: "c1", key: "name", label: "Name", type: "text", isCore: true, isRequired: true, archived: false, options: [] },
];

describe("custom-field schemas (report §6)", () => {
  const { create, patch } = buildCustomFieldSchemas(defs, { defaultCountry: "AE" });

  it("accepts valid values and normalises them", () => {
    expect(create.parse({ struggles: ["o1", "o2"], budget: 1500.5, call_on: "2026-10-01", alt_phone: "050 123 4567", handled_by: "0190e0c0-0000-7000-8000-000000000001" })).toEqual({
      struggles: ["o1", "o2"],
      budget: 1500.5,
      call_on: "2026-10-01",
      alt_phone: "+971501234567",
      handled_by: "0190e0c0-0000-7000-8000-000000000001",
    });
  });

  it("enforces required fields on create but not on patch", () => {
    expect(create.safeParse({}).success).toBe(false);
    expect(patch.safeParse({}).success).toBe(true);
  });

  it("rejects unknown, archived, core and badly typed values", () => {
    expect(patch.safeParse({ nope: 1 }).success).toBe(false);
    expect(patch.safeParse({ legacy: "x" }).success).toBe(false);
    expect(patch.safeParse({ name: "x" }).success).toBe(false);
    expect(patch.safeParse({ struggles: ["o3"] }).success).toBe(false); // archived option
    expect(patch.safeParse({ struggles: ["o1", "o1"] }).success).toBe(false);
    expect(patch.safeParse({ budget: 10.001 }).success).toBe(false);
    expect(patch.safeParse({ call_on: "01/10/2026" }).success).toBe(false);
    expect(patch.safeParse({ alt_phone: "9876543210x" }).success).toBe(false);
  });

  it("null clears an optional field, never a required one", () => {
    expect(patch.parse({ call_on: null })).toEqual({ call_on: null });
    expect(patch.safeParse({ budget: null }).success).toBe(false);
  });

  it("normalises Instagram handles", () => {
    expect(normalizeInstagram("@Asha.K ")).toBe("asha.k");
  });
});

describe("field access merge (report §7.1)", () => {
  it("is widest-wins across roles, and a role without a row means edit", () => {
    const rows = [
      { roleId: "r1", fieldId: "phone", access: "hidden" as const },
      { roleId: "r2", fieldId: "phone", access: "view" as const },
      { roleId: "r1", fieldId: "budget", access: "hidden" as const },
    ];
    const m = mergeFieldAccess(["r1", "r2"], rows);
    expect(fieldAccessOf(m, "phone")).toBe("view");
    expect(fieldAccessOf(m, "budget")).toBe("edit"); // r2 has no row for budget
    expect(fieldAccessOf(mergeFieldAccess(["r1"], rows), "budget")).toBe("hidden");
    expect(fieldAccessOf(m, "anything-else")).toBe("edit");
  });
});

describe("presets (report §15.3, spec §1 #7)", () => {
  it("define every core field once", () => {
    expect(CORE_FIELDS.map((f) => f.key)).toEqual(["name", "phone", "email", "instagram", "owner", "stage", "source", "value", "lead_created_at"]);
    expect(CORE_FIELD_KEYS.has("phone")).toBe(true);
  });

  it("each pipeline has open stages first and at least one won and one lost stage", () => {
    for (const p of Object.values(PRESETS)) {
      const kinds = p.pipeline.stages.map((s) => s.kind);
      expect(kinds[0]).toBe("open");
      expect(kinds).toContain("won");
      expect(kinds).toContain("lost");
      for (const f of p.fields) expect(CORE_FIELD_KEYS.has(f.key)).toBe(false);
    }
  });

  it("Nupuur's preset is the report's pipeline and fields", () => {
    const c = PRESETS.coaching;
    expect(c.pipeline.stages.map((s) => s.name)).toEqual(["New", "Message sent", "Replied", "Call booked", "Call done", "Follow-up later", "Won", "Lost"]);
    expect(c.fields.map((f) => [f.key, f.type])).toEqual([["struggles", "multi_select"], ["handled_by", "user"]]);
  });
});
```

Append to `packages/core/src/rbac/rbac.test.ts`:
```ts
describe("canOnRecord (scoped write checks)", () => {
  const rep = actor([{ key: "leads.edit", scope: "own" }, { key: "leads.assign", scope: "team" }], { userId: "me", teamMemberIds: ["me", "m2"] });
  it("own scope covers only my records, team adds my team's, nothing covers unassigned below all", () => {
    expect(canOnRecord(rep, "leads.edit", "me")).toBe(true);
    expect(canOnRecord(rep, "leads.edit", "m2")).toBe(false);
    expect(canOnRecord(rep, "leads.assign", "m2")).toBe(true);
    expect(canOnRecord(rep, "leads.assign", "stranger")).toBe(false);
    expect(canOnRecord(rep, "leads.assign", null)).toBe(false);
    expect(canOnRecord(rep, "leads.delete", "me")).toBe(false);
  });
  it("all scope and the owner cover everything", () => {
    expect(canOnRecord(actor([{ key: "leads.edit", scope: "all" }]), "leads.edit", null)).toBe(true);
    expect(canOnRecord(actor([], { isOwner: true }), "leads.delete", "anyone")).toBe(true);
  });
});
```
Also add `canOnRecord` to that file's import from `./engine`.

- [ ] **Step 3: Run to verify they fail**

Run: `scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile >/dev/null && pnpm vitest run packages/core'`
Expected: FAIL (modules not found; `canOnRecord` not exported).

- [ ] **Step 4: Implement**

`packages/core/src/leads/phone.ts`:
```ts
import { parsePhoneNumberFromString, type CountryCode, type PhoneNumber } from "libphonenumber-js/max";

export type PhoneStatus = "valid" | "needs_country" | "invalid" | "missing";
export type NormalizedPhone = { raw: string | null; e164: string | null; countryIso: string | null; status: PhoneStatus };

const valid = (raw: string, p: PhoneNumber): NormalizedPhone => ({ raw, e164: p.number, countryIso: p.country ?? null, status: "valid" });

/**
 * Report §8.4. Keep the raw value; accept a number only when libphonenumber says it is valid.
 * A number without an international prefix is parsed with the default country if there is one, and
 * otherwise (or when that fails) is marked `needs_country`. Nothing is ever guessed silently.
 */
export function normalizePhone(input: string | null | undefined, defaultCountry?: string | null): NormalizedPhone {
  const raw = input?.trim() ?? "";
  if (!raw) return { raw: null, e164: null, countryIso: null, status: "missing" };
  let s = raw.replace(/[\s\-.()\xA0]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (!/^\+?\d+$/.test(s)) return { raw, e164: null, countryIso: null, status: "invalid" };
  if (s.startsWith("+")) {
    const p = parsePhoneNumberFromString(s);
    return p?.isValid() ? valid(raw, p) : { raw, e164: null, countryIso: null, status: "invalid" };
  }
  if (s.length < 6) return { raw, e164: null, countryIso: null, status: "invalid" };
  if (defaultCountry) {
    const p = parsePhoneNumberFromString(s, defaultCountry as CountryCode);
    if (p?.isValid()) return valid(raw, p);
  }
  return { raw, e164: null, countryIso: null, status: "needs_country" };
}

export function formatPhone(e164: string): string {
  return parsePhoneNumberFromString(e164)?.formatInternational() ?? e164;
}
```

`packages/core/src/leads/mask.ts`:
```ts
import { parsePhoneNumberFromString } from "libphonenumber-js/max";

const DOTS = "•••";

/** "+971 50 ••• ••67": dial code, first two national digits, last two (spec §3 Leads). */
export function maskPhone(p: { e164: string | null; raw: string | null }): string {
  const parsed = p.e164 ? parsePhoneNumberFromString(p.e164) : undefined;
  if (parsed) {
    const nat = String(parsed.nationalNumber);
    return `+${parsed.countryCallingCode} ${nat.slice(0, 2)} ${DOTS} ••${nat.slice(-2)}`;
  }
  const digits = (p.raw ?? "").replace(/\D/g, "");
  return `${DOTS} ••${digits.slice(-2)}`;
}

export function maskEmail(e: string): string {
  const at = e.lastIndexOf("@");
  if (at < 1) return DOTS;
  return `${e[0]}${DOTS}${e.slice(at)}`;
}

export function maskInstagram(h: string): string {
  const s = h.replace(/^@/, "");
  return s.length > 1 ? `@${s[0]}${DOTS}${s[s.length - 1]}` : `@${s}${DOTS}`;
}
```

`packages/core/src/leads/custom-fields.ts`:
```ts
import { z } from "zod";
import { normalizePhone } from "./phone";

export const FIELD_TYPES = [
  "text", "long_text", "number", "currency", "date", "datetime", "boolean",
  "select", "multi_select", "phone", "email", "url", "user", "instagram",
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
      return z.email().max(254).transform((v) => v.toLowerCase());
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
```

`packages/core/src/leads/field-access.ts`:
```ts
export type FieldAccess = "hidden" | "view" | "edit";
const RANK: Record<FieldAccess, number> = { hidden: 0, view: 1, edit: 2 };

/**
 * Report §7.1 field-level access, unioned like permissions: for each field the widest access any of the
 * user's roles gives wins, and a role with no row for a field gives `edit`. Only fields that end up
 * narrower than `edit` are returned.
 */
export function mergeFieldAccess(
  roleIds: string[],
  rows: { roleId: string; fieldId: string; access: FieldAccess }[],
): Map<string, FieldAccess> {
  const perField = new Map<string, Map<string, FieldAccess>>();
  for (const r of rows) {
    if (!perField.has(r.fieldId)) perField.set(r.fieldId, new Map());
    perField.get(r.fieldId)!.set(r.roleId, r.access);
  }
  const out = new Map<string, FieldAccess>();
  for (const [fieldId, byRole] of perField) {
    let best: FieldAccess = "hidden";
    for (const roleId of roleIds) {
      const a = byRole.get(roleId) ?? "edit";
      if (RANK[a] > RANK[best]) best = a;
    }
    if (roleIds.length > 0 && best !== "edit") out.set(fieldId, best);
  }
  return out;
}

export const fieldAccessOf = (m: ReadonlyMap<string, FieldAccess>, fieldId: string): FieldAccess => m.get(fieldId) ?? "edit";
export const FIELD_ACCESS_RANK = RANK;
```

`packages/core/src/leads/presets.ts`:
```ts
import type { FieldType } from "./custom-fields";

export type StageKind = "open" | "won" | "lost";
export type StageSeed = { name: string; kind: StageKind; color: string; winProbability: number };
export type FieldSeed = { key: string; label: string; type: FieldType; options?: { label: string; color?: string }[] };
export type Preset = {
  key: PresetKey;
  label: string;
  pipeline: { name: string; stages: StageSeed[] };
  fields: FieldSeed[];
  lostReasons: string[];
};
export type PresetKey = "coaching" | "general";

/** Report §6: core fields are real columns on every install; they can be relabelled and hidden, never deleted. */
export const CORE_FIELDS: { key: string; label: string; type: FieldType; isRequired: boolean }[] = [
  { key: "name", label: "Name", type: "text", isRequired: true },
  { key: "phone", label: "Phone", type: "phone", isRequired: false },
  { key: "email", label: "Email", type: "email", isRequired: false },
  { key: "instagram", label: "Instagram", type: "instagram", isRequired: false },
  { key: "owner", label: "Handled by (owner)", type: "user", isRequired: false },
  { key: "stage", label: "Stage", type: "select", isRequired: true },
  { key: "source", label: "Source", type: "text", isRequired: false },
  { key: "value", label: "Value", type: "currency", isRequired: false },
  { key: "lead_created_at", label: "Date", type: "date", isRequired: false },
];
export const CORE_FIELD_KEYS: ReadonlySet<string> = new Set(CORE_FIELDS.map((f) => f.key));

export const PRESETS: Record<PresetKey, Preset> = {
  // Nupuur's install (report §15.3, spec §1 #7). Options and lost reasons are starters Tasneem can edit.
  coaching: {
    key: "coaching",
    label: "Coaching / consulting",
    pipeline: {
      name: "Coaching sales",
      stages: [
        { name: "New", kind: "open", color: "accent", winProbability: 5 },
        { name: "Message sent", kind: "open", color: "cyan", winProbability: 10 },
        { name: "Replied", kind: "open", color: "meet", winProbability: 20 },
        { name: "Call booked", kind: "open", color: "warn", winProbability: 40 },
        { name: "Call done", kind: "open", color: "warn", winProbability: 60 },
        { name: "Follow-up later", kind: "open", color: "neutral", winProbability: 10 },
        { name: "Won", kind: "won", color: "ok", winProbability: 100 },
        { name: "Lost", kind: "lost", color: "danger", winProbability: 0 },
      ],
    },
    fields: [
      {
        key: "struggles",
        label: "Struggles",
        type: "multi_select",
        options: [
          { label: "Confidence", color: "accent" },
          { label: "Career direction", color: "cyan" },
          { label: "Relationships", color: "meet" },
          { label: "Stress & anxiety", color: "warn" },
          { label: "Health & habits", color: "ok" },
          { label: "Productivity", color: "neutral" },
        ],
      },
      { key: "handled_by", label: "Handled by", type: "user" },
    ],
    lostReasons: ["Not interested", "Price too high", "No response", "Bad timing", "Chose someone else", "Not a fit"],
  },
  general: {
    key: "general",
    label: "General sales",
    pipeline: {
      name: "Sales",
      stages: [
        { name: "New", kind: "open", color: "accent", winProbability: 10 },
        { name: "Contacted", kind: "open", color: "cyan", winProbability: 20 },
        { name: "Qualified", kind: "open", color: "meet", winProbability: 40 },
        { name: "Proposal", kind: "open", color: "warn", winProbability: 60 },
        { name: "Won", kind: "won", color: "ok", winProbability: 100 },
        { name: "Lost", kind: "lost", color: "danger", winProbability: 0 },
      ],
    },
    fields: [],
    lostReasons: ["Not interested", "Price", "No response", "Timing", "Went with a competitor"],
  },
};
```

Add to `packages/core/src/rbac/engine.ts`:
```ts
/**
 * Scoped permission on one record: `own` covers records I own, `team` adds records owned by members of
 * teams I lead, `all` covers everything including unassigned records. The owner covers everything.
 */
export function canOnRecord(actor: Actor, key: PermissionKey, ownerId: string | null): boolean {
  if (actor.isOwner) return true;
  const s = scopeOf(actor, key);
  if (s === null) return false;
  if (s === "all") return true;
  if (ownerId === null) return false;
  if (ownerId === actor.userId) return true;
  return s === "team" && actor.teamMemberIds.includes(ownerId);
}
```

Append to `packages/core/src/index.ts`:
```ts
export * from "./leads/phone";
export * from "./leads/mask";
export * from "./leads/custom-fields";
export * from "./leads/field-access";
export * from "./leads/presets";
```

- [ ] **Step 5: Run to verify they pass**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run packages/core && pnpm typecheck'`
Expected: all pass. If a libphonenumber vector disagrees (metadata updates), pick another number of the same kind that `isValid()` accepts, and keep the case's intent.

- [ ] **Step 6: Commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(core): phone normalisation, contact masks, runtime custom-field schemas, field-access merge, canOnRecord, presets

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 2: Configuration and lead schema with forced RLS

**Files:**
- Create: `packages/db/migrations/0008_configuration.sql`, `0009_leads.sql`, `0010_lead_rls.sql`
- Create: `packages/db/src/schema/types.ts`, `packages/db/src/schema/config.ts`, `packages/db/src/schema/leads.ts`, `packages/db/src/rls.test.ts`
- Modify: `packages/db/src/schema/identity.ts` (import shared types), `packages/db/src/schema/index.ts`, `infra/scripts/backup.sh`, `apps/worker/src/scripts.integration.test.ts`

**Interfaces:**
- Produces:
  - tables `pipelines, stages, field_definitions, lost_reasons, tags, products, role_field_access, leads, lead_tags, lead_stage_history, lead_assignment_history, activities, lead_contact_keys, reveal_counters, idempotency_keys`
  - SQL `lume_can_see_owner(uuid) boolean`
  - Drizzle `schema.pipelines`, `schema.stages`, `schema.fieldDefinitions`, `schema.lostReasons`, `schema.tags`, `schema.products`, `schema.roleFieldAccess`, `schema.leads`, `schema.leadTags`, `schema.leadStageHistory`, `schema.leadAssignmentHistory`, `schema.activities`, `schema.leadContactKeys`, `schema.revealCounters`, `schema.idempotencyKeys`
  - `contactKeyHash(kind, value)` (JS twin of the SQL trigger's hash), exported from `@lume/db`

- [ ] **Step 1: Write the failing RLS test**

`packages/db/src/rls.test.ts`:
```ts
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import { contactKeyHash } from "./contact-keys";
import { MIGRATIONS_DIR_DEFAULT, migrate } from "./migrate";
import { installQueueSchema } from "./queue-install";
import { createTestDatabase, type DbRole, type TestDatabase } from "./testing";

/**
 * Report §7.4 / §17 Phase 1 acceptance: row-level security alone — raw SQL as lume_app, no service
 * code — refuses out-of-scope leads and everything hanging off them.
 */
const U = {
  rep: "0190e0c0-0000-7000-8000-00000000000a",
  mate: "0190e0c0-0000-7000-8000-00000000000b",
  other: "0190e0c0-0000-7000-8000-00000000000c",
};
const L = { rep: "0190e0c0-0000-7000-8000-0000000000a1", mate: "0190e0c0-0000-7000-8000-0000000000b1", other: "0190e0c0-0000-7000-8000-0000000000c1", none: "0190e0c0-0000-7000-8000-0000000000d1" };

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
  await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
  await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
  await as("lume_owner", { scope: "all", user: U.rep }, async (c) => {
    for (const [id, email] of [[U.rep, "rep@x.com"], [U.mate, "mate@x.com"], [U.other, "other@x.com"]]) {
      await c.query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $2, 'active')", [id, email]);
    }
    await c.query("INSERT INTO pipelines (id, name, is_default) VALUES ('0190e0c0-0000-7000-8000-0000000000f1', 'P', true)");
    await c.query("INSERT INTO stages (id, pipeline_id, name, kind, position) VALUES ('0190e0c0-0000-7000-8000-0000000000f2', '0190e0c0-0000-7000-8000-0000000000f1', 'New', 'open', 0)");
    for (const [id, owner] of [[L.rep, U.rep], [L.mate, U.mate], [L.other, U.other], [L.none, null]] as const) {
      await c.query(
        "INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name, phone_e164, phone_status, email) VALUES ($1, '0190e0c0-0000-7000-8000-0000000000f1', '0190e0c0-0000-7000-8000-0000000000f2', $2, $1, $3, 'valid', $4)",
        [id, owner, id === L.other ? "+971501234567" : null, `${id}@leads.test`],
      );
      await c.query("INSERT INTO activities (id, lead_id, type) VALUES (gen_random_uuid(), $1, 'note')", [id]);
    }
  });
});
afterAll(async () => db.drop());

type Scope = { scope: "own" | "team" | "all" | null; user?: string; team?: string[] };
async function as<T>(role: DbRole, s: Scope, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: db.url(role) });
  await c.connect();
  try {
    await c.query("BEGIN");
    if (s.scope) {
      await c.query("SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', $2, true), set_config('lume.team_member_ids', $3, true)", [
        s.user ?? U.rep,
        s.scope,
        `{${(s.team ?? []).join(",")}}`,
      ]);
    }
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}
const ids = async (role: DbRole, s: Scope, sql: string) =>
  (await as(role, s, async (c) => (await c.query<{ id: string }>(sql)).rows.map((r) => r.id))).sort();

describe("RLS on leads, by raw SQL as lume_app", () => {
  it("own scope sees only my leads; team adds my team's; all sees everything incl. unassigned", async () => {
    expect(await ids("lume_app", { scope: "own" }, "SELECT id FROM leads")).toEqual([L.rep]);
    expect(await ids("lume_app", { scope: "team", team: [U.rep, U.mate] }, "SELECT id FROM leads")).toEqual([L.rep, L.mate].sort());
    expect(await ids("lume_app", { scope: "all" }, "SELECT id FROM leads")).toEqual(Object.values(L).sort());
  });

  it("fails closed: no request scope, no rows — even for the table owner", async () => {
    expect(await ids("lume_app", { scope: null }, "SELECT id FROM leads")).toEqual([]);
    expect(await ids("lume_owner", { scope: null }, "SELECT id FROM leads")).toEqual([]);
  });

  it("child tables inherit the lead's visibility", async () => {
    const rows = await as("lume_app", { scope: "own" }, async (c) => (await c.query("SELECT lead_id FROM activities")).rows);
    expect(rows).toEqual([{ lead_id: L.rep }]);
  });

  it("a rep cannot create a lead for someone else, or hang an activity off one they can't see", async () => {
    await expect(
      as("lume_app", { scope: "own" }, (c) =>
        c.query("INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name) VALUES (gen_random_uuid(), '0190e0c0-0000-7000-8000-0000000000f1', '0190e0c0-0000-7000-8000-0000000000f2', $1, 'x')", [U.other]),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      as("lume_app", { scope: "own" }, (c) => c.query("INSERT INTO activities (id, lead_id, type) VALUES (gen_random_uuid(), $1, 'note')", [L.other])),
    ).rejects.toThrow(/row-level security/);
  });

  it("updates reach only visible leads, but may hand a lead away; deletes and history rewrites do nothing", async () => {
    const touched = await as("lume_app", { scope: "own" }, async (c) => (await c.query("UPDATE leads SET name = 'hacked' WHERE id = $1", [L.other])).rowCount);
    expect(touched).toBe(0);
    await as("lume_app", { scope: "own" }, (c) => c.query("UPDATE leads SET owner_id = $1 WHERE id = $2", [U.mate, L.rep]));
    expect(await ids("lume_app", { scope: "own" }, "SELECT id FROM leads")).toEqual([]); // gone from my view at once
    const deleted = await as("lume_app", { scope: "all" }, async (c) => (await c.query("DELETE FROM leads")).rowCount);
    expect(deleted).toBe(0);
    await expect(as("lume_app", { scope: "all" }, (c) => c.query("UPDATE activities SET type = 'x'"))).rejects.toThrow(/permission denied/);
    await as("lume_app", { scope: "all" }, (c) => c.query("UPDATE leads SET owner_id = $1 WHERE id = $2", [U.rep, L.rep]));
  });

  it("the backup role reads every row (pg_dump --enable-row-security)", async () => {
    expect(await ids("lume_readonly_backup", { scope: null }, "SELECT id FROM leads")).toEqual(Object.values(L).sort());
  });
});

describe("contact keys (cross-scope duplicate detection without exposing contacts)", () => {
  it("hold only hashes, stay in sync, and are readable regardless of scope", async () => {
    const rows = await as("lume_app", { scope: "own" }, async (c) =>
      (await c.query("SELECT lead_id, kind, key_hash FROM lead_contact_keys WHERE kind = 'phone'")).rows,
    );
    expect(rows).toEqual([{ lead_id: L.other, kind: "phone", key_hash: contactKeyHash("phone", "+971501234567") }]);
    await as("lume_app", { scope: "all" }, (c) => c.query("UPDATE leads SET deleted_at = now() WHERE id = $1", [L.other]));
    const after = await as("lume_app", { scope: "own" }, async (c) => (await c.query("SELECT 1 FROM lead_contact_keys WHERE lead_id = $1", [L.other])).rowCount);
    expect(after).toBe(0); // deleted leads no longer count as duplicates
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/dev.sh run pnpm vitest run packages/db/src/rls.test.ts`
Expected: FAIL (`./contact-keys` missing; tables missing).

- [ ] **Step 3: Migrations**

`packages/db/migrations/0008_configuration.sql`:
```sql
-- Configuration (report §5.2, §6). Admin-editable; seeded from a code-defined industry preset at setup.
CREATE TABLE pipelines (
  id          uuid        PRIMARY KEY,
  name        citext      NOT NULL,
  is_default  boolean     NOT NULL DEFAULT false,
  position    integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX pipelines_live_name ON pipelines (name) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX pipelines_one_default ON pipelines ((true)) WHERE is_default AND archived_at IS NULL;

CREATE TABLE stages (
  id                 uuid          PRIMARY KEY,
  pipeline_id        uuid          NOT NULL REFERENCES pipelines (id),
  name               text          NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  color              text          NOT NULL DEFAULT 'neutral',
  position           integer       NOT NULL DEFAULT 0,
  kind               text          NOT NULL CHECK (kind IN ('open', 'won', 'lost')),
  win_probability    numeric(5, 2) CHECK (win_probability BETWEEN 0 AND 100),
  sla_hours          integer       CHECK (sla_hours > 0),
  required_field_ids uuid[]        NOT NULL DEFAULT '{}',
  on_enter           jsonb         NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz   NOT NULL DEFAULT now(),
  updated_at         timestamptz   NOT NULL DEFAULT now(),
  archived_at        timestamptz,
  UNIQUE (id, pipeline_id) -- lets leads reference (stage, pipeline) together
);
CREATE UNIQUE INDEX stages_live_name ON stages (pipeline_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE field_definitions (
  id            uuid        PRIMARY KEY,
  entity        text        NOT NULL DEFAULT 'lead' CHECK (entity = 'lead'),
  key           text        NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label         text        NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  type          text        NOT NULL CHECK (type IN ('text','long_text','number','currency','date','datetime','boolean',
                                                     'select','multi_select','phone','email','url','user','instagram')),
  options       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  is_core       boolean     NOT NULL DEFAULT false,
  is_required   boolean     NOT NULL DEFAULT false,
  is_unique     boolean     NOT NULL DEFAULT false,
  is_searchable boolean     NOT NULL DEFAULT false,
  position      integer     NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  CHECK (NOT (is_core AND archived_at IS NOT NULL))
);

CREATE TABLE lost_reasons (
  id          uuid        PRIMARY KEY,
  label       citext      NOT NULL,
  position    integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX lost_reasons_live_label ON lost_reasons (label) WHERE archived_at IS NULL;

CREATE TABLE tags (
  id         uuid        PRIMARY KEY,
  label      citext      NOT NULL UNIQUE,
  color      text        NOT NULL DEFAULT 'neutral',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id            uuid           PRIMARY KEY,
  name          citext         NOT NULL,
  default_value numeric(14, 2) CHECK (default_value >= 0),
  currency      char(3),
  created_at    timestamptz    NOT NULL DEFAULT now(),
  updated_at    timestamptz    NOT NULL DEFAULT now(),
  archived_at   timestamptz
);
CREATE UNIQUE INDEX products_live_name ON products (name) WHERE archived_at IS NULL;

CREATE TABLE role_field_access (
  role_id  uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  field_id uuid NOT NULL REFERENCES field_definitions (id) ON DELETE CASCADE,
  access   text NOT NULL CHECK (access IN ('hidden', 'view', 'edit')),
  PRIMARY KEY (role_id, field_id)
);

CREATE TRIGGER pipelines_updated_at BEFORE UPDATE ON pipelines FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER stages_updated_at BEFORE UPDATE ON stages FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER field_definitions_updated_at BEFORE UPDATE ON field_definitions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER products_updated_at BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

`packages/db/migrations/0009_leads.sql`:
```sql
-- Leads and activity (report §5.3, §5.6).
CREATE TABLE leads (
  id                uuid           PRIMARY KEY,
  pipeline_id       uuid           NOT NULL REFERENCES pipelines (id),
  stage_id          uuid           NOT NULL,
  owner_id          uuid           REFERENCES users (id),
  name              text           NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  phone_raw         text,
  phone_e164        text,
  phone_country_iso char(2),
  phone_status      text           NOT NULL DEFAULT 'missing' CHECK (phone_status IN ('valid', 'needs_country', 'invalid', 'missing')),
  phone_digits      text           GENERATED ALWAYS AS (regexp_replace(coalesce(phone_e164, phone_raw, ''), '\D', '', 'g')) STORED,
  email             citext,
  instagram_handle  citext,
  source_id         uuid, -- FK to lead_sources arrives with Phase 2
  external_ref      text,
  value             numeric(14, 2) CHECK (value >= 0),
  currency          char(3),
  product_id        uuid           REFERENCES products (id),
  lost_reason_id    uuid           REFERENCES lost_reasons (id),
  lost_note         text,
  won_at            timestamptz,
  lost_at           timestamptz,
  custom            jsonb          NOT NULL DEFAULT '{}'::jsonb,
  lead_created_at   date,
  last_activity_at  timestamptz,
  next_task_due_at  timestamptz,
  stage_entered_at  timestamptz    NOT NULL DEFAULT now(),
  version           integer        NOT NULL DEFAULT 1,
  created_by        uuid           REFERENCES users (id),
  created_at        timestamptz    NOT NULL DEFAULT now(),
  updated_at        timestamptz    NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  FOREIGN KEY (stage_id, pipeline_id) REFERENCES stages (id, pipeline_id)
);
CREATE INDEX leads_owner_stage ON leads (owner_id, stage_id) WHERE deleted_at IS NULL;
CREATE INDEX leads_pipeline_stage ON leads (pipeline_id, stage_id, stage_entered_at);
CREATE INDEX leads_phone ON leads (phone_e164);
CREATE INDEX leads_email ON leads (email);
CREATE INDEX leads_instagram ON leads (instagram_handle);
CREATE INDEX leads_name_trgm ON leads USING gin (name gin_trgm_ops);
CREATE INDEX leads_email_trgm ON leads USING gin ((email::text) gin_trgm_ops);
CREATE INDEX leads_phone_digits_trgm ON leads USING gin (phone_digits gin_trgm_ops);
CREATE INDEX leads_custom ON leads USING gin (custom jsonb_path_ops);
CREATE INDEX leads_updated ON leads (updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER leads_updated_at BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE lead_tags (
  lead_id uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  tag_id  uuid NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (lead_id, tag_id)
);
CREATE INDEX lead_tags_tag ON lead_tags (tag_id);

-- Insert-only: the analytics backbone (report §5.3).
CREATE TABLE lead_stage_history (
  id            bigserial   PRIMARY KEY,
  lead_id       uuid        NOT NULL REFERENCES leads (id),
  from_stage_id uuid        REFERENCES stages (id),
  to_stage_id   uuid        NOT NULL REFERENCES stages (id),
  pipeline_id   uuid        NOT NULL REFERENCES pipelines (id),
  changed_by    uuid        REFERENCES users (id),
  changed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_stage_history_funnel ON lead_stage_history (pipeline_id, to_stage_id, changed_at);
CREATE INDEX lead_stage_history_lead ON lead_stage_history (lead_id, changed_at);

CREATE TABLE lead_assignment_history (
  id           bigserial   PRIMARY KEY,
  lead_id      uuid        NOT NULL REFERENCES leads (id),
  from_user_id uuid        REFERENCES users (id),
  to_user_id   uuid        REFERENCES users (id),
  changed_by   uuid        REFERENCES users (id),
  changed_at   timestamptz NOT NULL DEFAULT now(),
  reason       text
);
CREATE INDEX lead_assignment_history_lead ON lead_assignment_history (lead_id, changed_at);

CREATE TABLE activities (
  id          uuid        PRIMARY KEY,
  lead_id     uuid        NOT NULL REFERENCES leads (id),
  user_id     uuid        REFERENCES users (id),
  type        text        NOT NULL CHECK (type ~ '^[a-z_]{2,40}$'),
  payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activities_lead ON activities (lead_id, occurred_at DESC);
CREATE INDEX activities_user ON activities (user_id, type, occurred_at);

-- Hashes of normalised contact values, for duplicate warnings across scopes (no RLS, no plaintext).
CREATE TABLE lead_contact_keys (
  lead_id  uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  kind     text NOT NULL CHECK (kind IN ('phone', 'email', 'instagram')),
  key_hash text NOT NULL,
  PRIMARY KEY (lead_id, kind)
);
CREATE INDEX lead_contact_keys_lookup ON lead_contact_keys (kind, key_hash);

CREATE FUNCTION lead_contact_key_hash(kind text, value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(kind || ':' || value, 'UTF8')), 'hex')
$$;

CREATE FUNCTION lead_contact_keys_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM lead_contact_keys WHERE lead_id = NEW.id;
  IF NEW.deleted_at IS NULL THEN
    IF NEW.phone_e164 IS NOT NULL THEN
      INSERT INTO lead_contact_keys VALUES (NEW.id, 'phone', lead_contact_key_hash('phone', NEW.phone_e164));
    END IF;
    IF NEW.email IS NOT NULL THEN
      INSERT INTO lead_contact_keys VALUES (NEW.id, 'email', lead_contact_key_hash('email', lower(NEW.email::text)));
    END IF;
    IF NEW.instagram_handle IS NOT NULL THEN
      INSERT INTO lead_contact_keys VALUES (NEW.id, 'instagram', lead_contact_key_hash('instagram', lower(NEW.instagram_handle::text)));
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER leads_contact_keys AFTER INSERT OR UPDATE OF phone_e164, email, instagram_handle, deleted_at ON leads
  FOR EACH ROW EXECUTE FUNCTION lead_contact_keys_sync();

-- Reveal metering (report §12.2): per user per hour.
CREATE TABLE reveal_counters (
  user_id uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  hour    timestamptz NOT NULL,
  count   integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, hour)
);

-- Idempotency-Key replay (report §4.4): 24 h, purged hourly by the worker.
CREATE TABLE idempotency_keys (
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key          text        NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  route        text        NOT NULL,
  request_hash text        NOT NULL,
  status       integer     NOT NULL,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_age ON idempotency_keys (created_at);

-- History is insert-only for the app; the worker has no business with lead data yet.
REVOKE UPDATE, DELETE, TRUNCATE ON lead_stage_history, lead_assignment_history, activities FROM lume_app;
REVOKE ALL ON leads, lead_tags, lead_stage_history, lead_assignment_history, activities, lead_contact_keys, reveal_counters FROM lume_worker;
REVOKE INSERT, UPDATE ON idempotency_keys FROM lume_worker;
```

`packages/db/migrations/0010_lead_rls.sql`:
```sql
-- Report §7.4: row-level security, FORCEd so even the table owner is bound. Fails closed: with no
-- request scope (lume_scope() is NULL) nothing is visible.
CREATE FUNCTION lume_can_see_owner(owner uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    lume_scope() = 'all'
    OR (owner IS NOT NULL AND lume_user() IS NOT NULL AND (
      owner = lume_user()
      OR (lume_scope() = 'team' AND owner = ANY (lume_team_members()))
    )),
    false)
$$;

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE ROW LEVEL SECURITY;
CREATE POLICY leads_read ON leads FOR SELECT USING (lume_can_see_owner(owner_id));
CREATE POLICY leads_create ON leads FOR INSERT WITH CHECK (lume_can_see_owner(owner_id));
-- Update only what you can see; the new row need not stay visible (handing a lead to someone else).
CREATE POLICY leads_update ON leads FOR UPDATE USING (lume_can_see_owner(owner_id)) WITH CHECK (lume_user() IS NOT NULL);
-- No DELETE policy: leads are soft-deleted.

-- Children inherit the lead's visibility (the subquery is itself filtered by leads_read).
ALTER TABLE lead_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_tags FORCE ROW LEVEL SECURITY;
CREATE POLICY lead_tags_read ON lead_tags FOR SELECT USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));
CREATE POLICY lead_tags_create ON lead_tags FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));
CREATE POLICY lead_tags_remove ON lead_tags FOR DELETE USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));

ALTER TABLE lead_stage_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_stage_history FORCE ROW LEVEL SECURITY;
CREATE POLICY lead_stage_history_read ON lead_stage_history FOR SELECT USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));
CREATE POLICY lead_stage_history_create ON lead_stage_history FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));

ALTER TABLE lead_assignment_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_assignment_history FORCE ROW LEVEL SECURITY;
CREATE POLICY lead_assignment_history_read ON lead_assignment_history FOR SELECT USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));
CREATE POLICY lead_assignment_history_create ON lead_assignment_history FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));

ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities FORCE ROW LEVEL SECURITY;
CREATE POLICY activities_read ON activities FOR SELECT USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));
CREATE POLICY activities_create ON activities FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));

-- Backups: pg_dump --enable-row-security as lume_readonly_backup dumps everything through these.
CREATE POLICY backup_read ON leads FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON lead_tags FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON lead_stage_history FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON lead_assignment_history FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON activities FOR SELECT TO lume_readonly_backup USING (true);
```

- [ ] **Step 4: Drizzle mirror and hash helper**

`packages/db/src/schema/types.ts` (the four custom types moved out of `identity.ts`, which now imports them from here):
```ts
import { customType, timestamp } from "drizzle-orm/pg-core";

export const citext = customType<{ data: string }>({ dataType: () => "citext" });
export const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
export const inet = customType<{ data: string }>({ dataType: () => "inet" });
export const cidrArray = customType<{ data: string[] }>({ dataType: () => "cidr[]" });
export const tz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
```

`packages/db/src/schema/config.ts`:
```ts
import { sql } from "drizzle-orm";
import { boolean, integer, jsonb, numeric, pgTable, primaryKey, char, text, uuid } from "drizzle-orm/pg-core";
import { citext, tz } from "./types";

export type FieldOptionRow = { id: string; label: string; color?: string; archived?: boolean };

export const pipelines = pgTable("pipelines", {
  id: uuid("id").primaryKey(),
  name: citext("name").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  position: integer("position").notNull().default(0),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  archivedAt: tz("archived_at"),
});

export const stages = pgTable("stages", {
  id: uuid("id").primaryKey(),
  pipelineId: uuid("pipeline_id").notNull(),
  name: text("name").notNull(),
  color: text("color").notNull().default("neutral"),
  position: integer("position").notNull().default(0),
  kind: text("kind").$type<"open" | "won" | "lost">().notNull(),
  winProbability: numeric("win_probability", { precision: 5, scale: 2, mode: "number" }),
  slaHours: integer("sla_hours"),
  requiredFieldIds: uuid("required_field_ids").array().notNull().default(sql`'{}'`),
  onEnter: jsonb("on_enter").notNull().default(sql`'{}'::jsonb`),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  archivedAt: tz("archived_at"),
});

export const fieldDefinitions = pgTable("field_definitions", {
  id: uuid("id").primaryKey(),
  entity: text("entity").notNull().default("lead"),
  key: text("key").notNull().unique(),
  label: text("label").notNull(),
  type: text("type").$type<import("@lume/core").FieldType>().notNull(),
  options: jsonb("options").$type<FieldOptionRow[]>().notNull().default(sql`'[]'::jsonb`),
  isCore: boolean("is_core").notNull().default(false),
  isRequired: boolean("is_required").notNull().default(false),
  isUnique: boolean("is_unique").notNull().default(false),
  isSearchable: boolean("is_searchable").notNull().default(false),
  position: integer("position").notNull().default(0),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  archivedAt: tz("archived_at"),
});

export const lostReasons = pgTable("lost_reasons", {
  id: uuid("id").primaryKey(),
  label: citext("label").notNull(),
  position: integer("position").notNull().default(0),
  createdAt: tz("created_at").notNull().defaultNow(),
  archivedAt: tz("archived_at"),
});

export const tags = pgTable("tags", {
  id: uuid("id").primaryKey(),
  label: citext("label").notNull().unique(),
  color: text("color").notNull().default("neutral"),
  createdAt: tz("created_at").notNull().defaultNow(),
});

export const products = pgTable("products", {
  id: uuid("id").primaryKey(),
  name: citext("name").notNull(),
  defaultValue: numeric("default_value", { precision: 14, scale: 2, mode: "number" }),
  currency: char("currency", { length: 3 }),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  archivedAt: tz("archived_at"),
});

export const roleFieldAccess = pgTable(
  "role_field_access",
  {
    roleId: uuid("role_id").notNull(),
    fieldId: uuid("field_id").notNull(),
    access: text("access").$type<"hidden" | "view" | "edit">().notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.fieldId] })],
);
```

`packages/db/src/schema/leads.ts`:
```ts
import { sql } from "drizzle-orm";
import { bigserial, char, date, integer, jsonb, numeric, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { citext, tz } from "./types";

export const leads = pgTable("leads", {
  id: uuid("id").primaryKey(),
  pipelineId: uuid("pipeline_id").notNull(),
  stageId: uuid("stage_id").notNull(),
  ownerId: uuid("owner_id"),
  name: text("name").notNull(),
  phoneRaw: text("phone_raw"),
  phoneE164: text("phone_e164"),
  phoneCountryIso: char("phone_country_iso", { length: 2 }),
  phoneStatus: text("phone_status").$type<"valid" | "needs_country" | "invalid" | "missing">().notNull().default("missing"),
  phoneDigits: text("phone_digits").generatedAlwaysAs(sql`regexp_replace(coalesce(phone_e164, phone_raw, ''), '\\D', '', 'g')`),
  email: citext("email"),
  instagramHandle: citext("instagram_handle"),
  sourceId: uuid("source_id"),
  externalRef: text("external_ref"),
  value: numeric("value", { precision: 14, scale: 2, mode: "number" }),
  currency: char("currency", { length: 3 }),
  productId: uuid("product_id"),
  lostReasonId: uuid("lost_reason_id"),
  lostNote: text("lost_note"),
  wonAt: tz("won_at"),
  lostAt: tz("lost_at"),
  custom: jsonb("custom").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  leadCreatedAt: date("lead_created_at", { mode: "string" }),
  lastActivityAt: tz("last_activity_at"),
  nextTaskDueAt: tz("next_task_due_at"),
  stageEnteredAt: tz("stage_entered_at").notNull().defaultNow(),
  version: integer("version").notNull().default(1),
  createdBy: uuid("created_by"),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  deletedAt: tz("deleted_at"),
});

export const leadTags = pgTable("lead_tags", { leadId: uuid("lead_id").notNull(), tagId: uuid("tag_id").notNull() }, (t) => [
  primaryKey({ columns: [t.leadId, t.tagId] }),
]);

export const leadStageHistory = pgTable("lead_stage_history", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  leadId: uuid("lead_id").notNull(),
  fromStageId: uuid("from_stage_id"),
  toStageId: uuid("to_stage_id").notNull(),
  pipelineId: uuid("pipeline_id").notNull(),
  changedBy: uuid("changed_by"),
  changedAt: tz("changed_at").notNull().defaultNow(),
});

export const leadAssignmentHistory = pgTable("lead_assignment_history", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  leadId: uuid("lead_id").notNull(),
  fromUserId: uuid("from_user_id"),
  toUserId: uuid("to_user_id"),
  changedBy: uuid("changed_by"),
  changedAt: tz("changed_at").notNull().defaultNow(),
  reason: text("reason"),
});

export const activities = pgTable("activities", {
  id: uuid("id").primaryKey(),
  leadId: uuid("lead_id").notNull(),
  userId: uuid("user_id"),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  occurredAt: tz("occurred_at").notNull().defaultNow(),
});

export const leadContactKeys = pgTable(
  "lead_contact_keys",
  { leadId: uuid("lead_id").notNull(), kind: text("kind").$type<"phone" | "email" | "instagram">().notNull(), keyHash: text("key_hash").notNull() },
  (t) => [primaryKey({ columns: [t.leadId, t.kind] })],
);

export const revealCounters = pgTable(
  "reveal_counters",
  { userId: uuid("user_id").notNull(), hour: tz("hour").notNull(), count: integer("count").notNull().default(0) },
  (t) => [primaryKey({ columns: [t.userId, t.hour] })],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    userId: uuid("user_id").notNull(),
    key: text("key").notNull(),
    route: text("route").notNull(),
    requestHash: text("request_hash").notNull(),
    status: integer("status").notNull(),
    response: jsonb("response"),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);
```

`packages/db/src/schema/index.ts`:
```ts
export * from "./identity";
export * from "./config";
export * from "./leads";
```

`packages/db/src/contact-keys.ts`:
```ts
import { createHash } from "node:crypto";

/** JS twin of SQL lead_contact_key_hash(): values must already be normalised (E.164, lower-case). */
export const contactKeyHash = (kind: "phone" | "email" | "instagram", value: string): string =>
  createHash("sha256").update(`${kind}:${value}`, "utf8").digest("hex");
```
Append to `packages/db/src/index.ts`: `export * from "./contact-keys";`.

- [ ] **Step 5: Backups under RLS**

In `infra/scripts/backup.sh`, change the dump line to:
```bash
# --enable-row-security: lead tables FORCE RLS; the backup role reads them through its backup_read policies.
pg_dump --format=custom --compress=6 --enable-row-security --dbname="$DATABASE_URL_BACKUP" | age "${recipients[@]}" -o "$work/$BACKUP_NAME"
```
In `apps/worker/src/scripts.integration.test.ts`, before the backup runs, seed one lead with request scope `all` as `lume_owner`. The test then proves that a dump with RLS data both backs up and restores:
```ts
  // Lead tables force RLS: prove backup + restore cope with real rows in them.
  const owner = new pg.Client({ connectionString: db.url("lume_owner") });
  await owner.connect();
  await owner.query("BEGIN");
  await owner.query("SELECT set_config('lume.user_id', '0190e0c0-0000-7000-8000-000000000001', true), set_config('lume.lead_scope', 'all', true)");
  await owner.query("INSERT INTO pipelines (id, name) VALUES ('0190e0c0-0000-7000-8000-0000000000f1', 'P')");
  await owner.query("INSERT INTO stages (id, pipeline_id, name, kind) VALUES ('0190e0c0-0000-7000-8000-0000000000f2', '0190e0c0-0000-7000-8000-0000000000f1', 'New', 'open')");
  await owner.query("INSERT INTO leads (id, pipeline_id, stage_id, name) VALUES (gen_random_uuid(), '0190e0c0-0000-7000-8000-0000000000f1', '0190e0c0-0000-7000-8000-0000000000f2', 'Backup me')");
  await owner.query("COMMIT");
  await owner.end();
```
(Add `import pg from "pg";` if the file lacks it. Place this in the `beforeAll`, after `migrate`.)

- [ ] **Step 6: Run to verify**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run packages/db apps/worker && pnpm typecheck'`
Expected: RLS (6), contact keys (1), drift (now one per table, 30) and the worker backup/restore integration tests all pass.

- [ ] **Step 7: Commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(db): configuration and lead schema, forced RLS proven by raw SQL, hashed contact keys, backups under RLS

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 3: API plumbing — field access on the actor, beforeCommit, idempotency, field registry, harness, purge job

**Files:**
- Modify: `apps/api/src/rbac/actor.ts`, `apps/api/src/db/context.ts`, `apps/api/src/app.ts`, `apps/api/test/harness.ts`, `packages/core/src/queues.ts`, `apps/worker/src/boss.ts`, `apps/worker/src/main.ts`
- Create: `apps/api/src/http/idempotency.ts`, `apps/api/src/http/idempotency.test.ts`, `apps/api/src/leads/fields.ts`, `apps/worker/src/maintenance.ts`, `apps/worker/src/maintenance.integration.test.ts`

**Interfaces:**
- Produces:
  - `ActorRecord.fieldAccess: ReadonlyMap<string, FieldAccess>`; `FastifyRequest.actor: ActorRecord | null`
  - `req.beforeCommit(fn: (r: { statusCode: number; payload: unknown }) => Promise<void>)`
  - `idempotency(scope)` (call after `dbContext`); route config `idempotent?: boolean`
  - `loadFieldRegistry(req): Promise<FieldRegistry>`, where `FieldRegistry = { version; defaultCountry; defs: FieldDef[]; byKey: Map; byId: Map; custom: { create; patch } }`, and `bumpFieldDefs(req)`
  - Harness additions:
    - `seedConfig(preset?)`: runs automatically unless `noSettings`
    - `config(): Promise<{ pipelineId; stages: Record<string, string>; fields: Record<string, string>; lostReasons: string[] }>`
    - `seedLead({ ownerId, name?, stage?, phone?, email? }): Promise<string>`
  - Worker: `makeMaintenanceJobs(pool, now?)` exposing `purgeIdempotencyKeys(): Promise<number>`; queue `ops.idempotency-cleanup` (hourly)

- [ ] **Step 1: Write the failing tests**

`apps/api/src/http/idempotency.test.ts`:
```ts
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../test/harness";
import { HttpError } from "./errors";

let h: Harness;
let c: AuthedClient;
beforeAll(async () => {
  h = await createHarness({
    extraRoutes: (app) => {
      app.post("/api/v1/t/make", { config: { permission: "auth.self" } }, async (req, reply) => {
        await req.db.execute(sql`INSERT INTO audit_log (action, entity_type) VALUES ('t.make', 't')`);
        return reply.code(201).send({ made: (req.body as { n: number }).n, at: Math.random() });
      });
      app.post("/api/v1/t/fail", { config: { permission: "auth.self" } }, async () => {
        throw new HttpError(409, "CONFLICT", "no");
      });
      app.post("/api/v1/t/reveal", { config: { permission: "auth.self", idempotent: false } }, async () => ({ secret: Math.random() }));
    },
  });
  c = await h.signIn(await h.seedUser({ grants: [] }));
});
afterAll(async () => h.close());

const made = async () => (await h.pool.query("SELECT count(*)::int n FROM audit_log WHERE action = 't.make'")).rows[0].n;
const post = (url: string, body: object, key?: string) =>
  c.inject({ method: "POST", url, payload: body, headers: key ? { "idempotency-key": key } : {} });

describe("Idempotency-Key (report §4.4)", () => {
  it("replays the first response exactly for the same key and body, doing the work once", async () => {
    const a = await post("/api/v1/t/make", { n: 1 }, "key-aaaaaaaa");
    const b = await post("/api/v1/t/make", { n: 1 }, "key-aaaaaaaa");
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json()).toEqual(a.json());
    expect(b.headers["idempotent-replay"]).toBe("true");
    expect(await made()).toBe(1);
  });

  it("refuses the same key with a different request", async () => {
    await post("/api/v1/t/make", { n: 2 }, "key-bbbbbbbb");
    const r = await post("/api/v1/t/make", { n: 3 }, "key-bbbbbbbb");
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("does not remember failures (the client may retry), and without a key does the work each time", async () => {
    expect((await post("/api/v1/t/fail", {}, "key-cccccccc")).statusCode).toBe(409);
    expect((await h.pool.query("SELECT count(*)::int n FROM idempotency_keys WHERE key = 'key-cccccccc'")).rows[0].n).toBe(0);
    const before = await made();
    await post("/api/v1/t/make", { n: 9 });
    await post("/api/v1/t/make", { n: 9 });
    expect(await made()).toBe(before + 2);
  });

  it("never stores responses of routes that opt out (reveal)", async () => {
    await post("/api/v1/t/reveal", {}, "key-dddddddd");
    expect((await h.pool.query("SELECT count(*)::int n FROM idempotency_keys WHERE key = 'key-dddddddd'")).rows[0].n).toBe(0);
  });

  it("expires after 24 hours", async () => {
    await post("/api/v1/t/make", { n: 5 }, "key-eeeeeeee");
    await h.ownerPool.query("UPDATE idempotency_keys SET created_at = now() - interval '25 hours' WHERE key = 'key-eeeeeeee'");
    const before = await made();
    expect((await post("/api/v1/t/make", { n: 6 }, "key-eeeeeeee")).statusCode).toBe(201);
    expect(await made()).toBe(before + 1);
  });

  it("rejects malformed keys", async () => {
    expect((await post("/api/v1/t/make", { n: 1 }, "short")).json().error.code).toBe("BAD_IDEMPOTENCY_KEY");
  });
});
```

`apps/worker/src/maintenance.integration.test.ts`:
```ts
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import { MIGRATIONS_DIR_DEFAULT, createTestDatabase, installQueueSchema, migrate, type TestDatabase } from "@lume/db";
import { makeMaintenanceJobs } from "./maintenance";

let db: TestDatabase;
let pool: pg.Pool;
beforeAll(async () => {
  db = await createTestDatabase();
  await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
  await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
  pool = new pg.Pool({ connectionString: db.url("lume_worker") });
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe("maintenance jobs (as lume_worker)", () => {
  it("purges idempotency keys older than 24 hours and keeps fresh ones", async () => {
    const owner = new pg.Client({ connectionString: db.url("lume_owner") });
    await owner.connect();
    await owner.query("INSERT INTO users (id, email, name, status) VALUES ('0190e0c0-0000-7000-8000-000000000001', 'a@x.com', 'A', 'active')");
    await owner.query(
      `INSERT INTO idempotency_keys (user_id, key, route, request_hash, status, created_at) VALUES
        ('0190e0c0-0000-7000-8000-000000000001', 'old-key-0001', 'POST /x', 'h', 201, now() - interval '25 hours'),
        ('0190e0c0-0000-7000-8000-000000000001', 'new-key-0001', 'POST /x', 'h', 201, now())`,
    );
    await owner.end();
    expect(await makeMaintenanceJobs(pool).purgeIdempotencyKeys()).toBe(1);
    expect((await pool.query("SELECT key FROM idempotency_keys")).rows).toEqual([{ key: "new-key-0001" }]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `scripts/dev.sh run pnpm vitest run apps/api/src/http/idempotency.test.ts apps/worker/src/maintenance.integration.test.ts`
Expected: FAIL (replay not implemented; module missing).

- [ ] **Step 3: Implement**

In `apps/api/src/rbac/actor.ts`, extend `ActorRecord` and `loadActor`:
```ts
import { mergeFieldAccess, type FieldAccess } from "@lume/core";
export type ActorRecord = Actor & { restrictions: RoleRestriction[]; fieldAccess: ReadonlyMap<string, FieldAccess> };
```
Add a fourth query to the `Promise.all`:
```ts
    pool.query<{ role_id: string; field_id: string; access: FieldAccess }>(
      `SELECT rfa.role_id, rfa.field_id, rfa.access
         FROM role_field_access rfa
         JOIN user_roles ur ON ur.role_id = rfa.role_id
         JOIN roles r ON r.id = rfa.role_id AND r.deleted_at IS NULL
        WHERE ur.user_id = $1`,
      [userId],
    ),
```
Then return, alongside the other fields:
```ts
    fieldAccess: user.is_owner
      ? new Map()
      : mergeFieldAccess([...restrictions.keys()], fa.rows.map((r) => ({ roleId: r.role_id, fieldId: r.field_id, access: r.access }))),
```
(`restrictions` is keyed by every role the user holds, including roles with no permissions, via the existing LEFT JOIN.)

In `apps/api/src/db/context.ts`:
- Change the `actor` declaration to `actor: import("../rbac/actor").ActorRecord | null;`, and `applyRequestScope(client, actor: Actor)` stays as is.
- Add to `FastifyRequest`:
```ts
    /** Run inside the transaction, just before COMMIT, with the response about to be sent. */
    beforeCommit(fn: (r: { statusCode: number; payload: unknown }) => Promise<void>): void;
```
- Extend `Held` with `beforeCommit: ((r: { statusCode: number; payload: unknown }) => Promise<void>)[]` and initialise it to `[]`.
- Decorate it the same way as `afterCommit`.
- Replace the `onSend` hook with:
```ts
  app.addHook("onSend", async (req, reply, payload) => {
    const h = held.get(req);
    let out = payload;
    if (h && !h.failed) {
      try {
        for (const fn of h.beforeCommit) await fn({ statusCode: reply.statusCode, payload });
      } catch (err) {
        // The response has not left yet: turn it into an error and roll everything back.
        h.failed = true;
        req.log.error({ err }, "before-commit step failed");
        void reply.code(500).header("content-type", "application/json; charset=utf-8");
        out = JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" } });
      }
    }
    await finish(req);
    return out;
  });
```

`apps/api/src/http/idempotency.ts`:
```ts
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { sha256Hex } from "@lume/core";
import { schema } from "@lume/db";
import { HttpError, badRequest } from "./errors";

declare module "fastify" {
  interface FastifyContextConfig {
    /** false: never replay or store (responses that must not be persisted, e.g. revealed contacts). */
    idempotent?: boolean;
  }
}

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const KEY_RE = /^[A-Za-z0-9_-]{8,200}$/;
const TTL_MS = 24 * 3600_000;

/**
 * Report §4.4: a retried or double-clicked mutation with the same Idempotency-Key replays the first
 * successful response instead of running again. Keys are per user; the stored record is written in the
 * same transaction as the change (beforeCommit), so it exists exactly when the change does. Call after
 * dbContext (needs req.db); concurrent requests with one key are serialised by an advisory lock.
 */
export function idempotency(app: FastifyInstance): void {
  app.addHook("preHandler", async (req, reply) => {
    if (!MUTATING.has(req.method) || req.routeOptions.config?.idempotent === false || !req.actor) return;
    const key = req.headers["idempotency-key"];
    if (key === undefined) return;
    if (typeof key !== "string" || !KEY_RE.test(key)) throw badRequest("BAD_IDEMPOTENCY_KEY", "Idempotency-Key must be 8-200 URL-safe characters");
    const userId = req.actor.userId;
    const route = `${req.method} ${req.routeOptions.url}`;
    const requestHash = sha256Hex(JSON.stringify({ params: req.params ?? null, query: req.query ?? null, body: req.body ?? null }));

    await req.db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${key}`}, 0))`);
    const where = and(eq(schema.idempotencyKeys.userId, userId), eq(schema.idempotencyKeys.key, key));
    const [prior] = await req.db.select().from(schema.idempotencyKeys).where(where);
    if (prior && Date.now() - prior.createdAt.getTime() > TTL_MS) {
      await req.db.delete(schema.idempotencyKeys).where(where);
    } else if (prior) {
      if (prior.route !== route || prior.requestHash !== requestHash) {
        throw new HttpError(422, "IDEMPOTENCY_MISMATCH", "This Idempotency-Key was already used for a different request");
      }
      void reply.header("idempotent-replay", "true");
      return reply.code(prior.status).send(prior.response ?? undefined);
    }

    req.beforeCommit(async ({ statusCode, payload }) => {
      if (statusCode < 200 || statusCode >= 300) return; // failures are not remembered: retry is allowed
      const response = typeof payload === "string" && payload.length ? (JSON.parse(payload) as unknown) : null;
      await req.db.insert(schema.idempotencyKeys).values({ userId, key, route, requestHash, status: statusCode, response });
    });
  });
}
```
Wire it in `apps/api/src/app.ts` right after `dbContext(scope, …)`: `idempotency(scope);`.

`apps/api/src/leads/fields.ts`:
```ts
import { asc, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { buildCustomFieldSchemas, type FieldDef } from "@lume/core";
import { schema } from "@lume/db";

export type FieldRegistry = {
  version: number;
  defaultCountry: string | null;
  defs: FieldDef[];
  byKey: ReadonlyMap<string, FieldDef>;
  byId: ReadonlyMap<string, FieldDef>;
  custom: ReturnType<typeof buildCustomFieldSchemas>;
};

declare module "fastify" {
  interface FastifyInstance {
    fieldRegistryCache: { value: FieldRegistry | null };
  }
}

/**
 * Field definitions + compiled custom-field schemas, rebuilt only when settings.field_defs_version (or the
 * default country) changes. Cached per app instance, so tests with separate databases never share it.
 */
export async function loadFieldRegistry(req: FastifyRequest): Promise<FieldRegistry> {
  const [s] = await req.db
    .select({ version: schema.settings.fieldDefsVersion, country: schema.settings.defaultCountryIso })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1));
  const version = s?.version ?? 0;
  const defaultCountry = s?.country ?? null;
  const cache = req.server.fieldRegistryCache;
  if (cache.value && cache.value.version === version && cache.value.defaultCountry === defaultCountry) return cache.value;
  const rows = await req.db.select().from(schema.fieldDefinitions).orderBy(asc(schema.fieldDefinitions.position), asc(schema.fieldDefinitions.key));
  const defs: FieldDef[] = rows.map((r) => ({
    id: r.id,
    key: r.key,
    label: r.label,
    type: r.type,
    options: r.options,
    isCore: r.isCore,
    isRequired: r.isRequired,
    archived: r.archivedAt !== null,
  }));
  cache.value = {
    version,
    defaultCountry,
    defs,
    byKey: new Map(defs.map((d) => [d.key, d])),
    byId: new Map(defs.map((d) => [d.id, d])),
    custom: buildCustomFieldSchemas(defs, { defaultCountry }),
  };
  return cache.value;
}

/** Call in the same transaction as any field-definition change (or default-country change). */
export async function bumpFieldDefs(req: FastifyRequest): Promise<void> {
  await req.db.execute(sql`UPDATE settings SET field_defs_version = field_defs_version + 1 WHERE id = 1`);
}
```
In `app.ts` inside `register`, add `scope.decorate("fieldRegistryCache", { value: null });`. In `modules/settings/routes.ts` PATCH, call `await bumpFieldDefs(req)` when `defaultCountry` changes.

Harness (`apps/api/test/harness.ts`) additions:
```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { schema as dbSchema } from "@lume/db";
import { seedConfiguration } from "../src/modules/pipelines/seed";
// …
export const SYSTEM_USER = "0190e0c0-0000-7000-8000-000000000000";

/** Run as lume_owner inside a transaction with request scope `all` (lead tables FORCE RLS even for the owner). */
async function withAllScope<T>(ownerPool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)", [SYSTEM_USER]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
```
Add these, plus matching entries on the `Harness` type:
- In `createHarness`, after inserting settings (when `!noSettings`):
```ts
    await withAllScope(ownerPool, (c) => seedConfiguration(drizzle(c, { schema: dbSchema }), opts.preset ?? "general"));
```
  Add `preset?: PresetKey` to the options.
- Methods:
```ts
    async config() {
      const [p] = (await ownerPool.query("SELECT id FROM pipelines WHERE is_default")).rows;
      const stages = Object.fromEntries((await ownerPool.query("SELECT name, id FROM stages WHERE pipeline_id = $1 AND archived_at IS NULL", [p.id])).rows.map((r) => [r.name, r.id]));
      const fields = Object.fromEntries((await ownerPool.query("SELECT key, id FROM field_definitions")).rows.map((r) => [r.key, r.id]));
      const lostReasons = (await ownerPool.query("SELECT id FROM lost_reasons ORDER BY position")).rows.map((r) => r.id as string);
      return { pipelineId: p.id as string, stages, fields, lostReasons };
    },
    async seedLead(o) {
      const cfg = await h.config();
      const id = newId();
      await withAllScope(ownerPool, (c) =>
        c.query(
          `INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name, phone_e164, phone_status, email)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, cfg.pipelineId, cfg.stages[o.stage ?? "New"], o.ownerId, o.name ?? `Lead ${id.slice(-6)}`, o.phone ?? null, o.phone ? "valid" : "missing", o.email ?? null],
        ),
      );
      return id;
    },
```
  Types: `config(): Promise<{ pipelineId: string; stages: Record<string, string>; fields: Record<string, string>; lostReasons: string[] }>` and `seedLead(o: { ownerId: string | null; name?: string; stage?: string; phone?: string; email?: string }): Promise<string>`.

`packages/core/src/queues.ts`:
```ts
export const QUEUE_NAMES = ["ops.backup", "ops.restore-test", "ops.idempotency-cleanup"] as const;
```

`apps/worker/src/maintenance.ts`:
```ts
import type pg from "pg";

export type MaintenanceJobs = { purgeIdempotencyKeys(): Promise<number> };

/** Housekeeping as lume_worker. Idempotency keys live 24 h (report §4.4). */
export function makeMaintenanceJobs(pool: pg.Pool, now: () => Date = () => new Date()): MaintenanceJobs {
  return {
    async purgeIdempotencyKeys() {
      const cutoff = new Date(now().getTime() - 24 * 3600_000);
      const r = await pool.query("DELETE FROM idempotency_keys WHERE created_at < $1", [cutoff]);
      return r.rowCount ?? 0;
    },
  };
}
```
In `apps/worker/src/boss.ts`, add `maintenance: MaintenanceJobs` to the options and, after the existing workers:
```ts
  await boss.schedule("ops.idempotency-cleanup", "17 * * * *", {}, { tz: "UTC" });
  await boss.work("ops.idempotency-cleanup", { batchSize: 1 }, async () => {
    const purged = await opts.maintenance.purgeIdempotencyKeys();
    opts.log.info({ purged }, "idempotency keys purged");
  });
```
In `apps/worker/src/main.ts`, pass `maintenance: makeMaintenanceJobs(pool)` to `startQueue`. Update `boss.integration.test.ts` to pass `maintenance: { purgeIdempotencyKeys: async () => 0 }` wherever it calls `startQueue`.

Pipelines seeding (`apps/api/src/modules/pipelines/seed.ts`) is created in Task 4. Create it in this task already, as shown in Task 4 Step 3, because the harness imports it.

- [ ] **Step 4: Run to verify**

Run: `scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile >/dev/null && pnpm lint && pnpm typecheck && pnpm test'`
Expected: idempotency (6) and maintenance (1) pass. Everything else stays green, and the 1A matrix is unaffected.

- [ ] **Step 5: Commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(api): field access on the actor, beforeCommit, Idempotency-Key replay, field registry, hourly key purge

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 4: Pipelines and stages (+ preset seeding at setup)

**Files:**
- Create: `apps/api/src/modules/pipelines/{seed,service,routes}.ts`, `apps/api/src/modules/pipelines/pipelines.test.ts`
- Modify: `apps/api/src/modules/setup/service.ts` (replace `presetAppliers` with `seedConfiguration`), `apps/api/src/modules/setup/setup.test.ts`, `apps/api/src/app.ts`

**Interfaces:**
- Produces:
  - `seedConfiguration(db: Db, preset: PresetKey): Promise<void>`
  - `GET /pipelines` (leads.view) → `{ pipelines: { id, name, isDefault, position, stages: StageView[] }[] }`, where `StageView = { id, name, color, position, kind, winProbability, slaHours, requiredFieldIds }`
  - `POST /pipelines` (pipelines.manage) `{ name }` → 201 `{ pipeline }` (with New/Won/Lost)
  - `PATCH /pipelines/:id` `{ name?, isDefault?, position? }`; `POST /pipelines/:id/archive` → 204
  - `POST /pipelines/:id/stages` `{ name, kind, color?, winProbability?, slaHours?, requiredFieldIds? }` → 201 `{ stage }`
  - `PATCH /stages/:id` (same fields, all optional) → `{ stage }`
  - `PUT /pipelines/:id/stage-order` `{ stageIds }` → `{ pipeline }`
  - `POST /stages/:id/archive` `{ moveToStageId? }` → 204
  - Invariants: at least one active `won` and one `lost` stage per pipeline (`400 STAGE_KINDS_REQUIRED`); archive with leads needs `moveToStageId` of an open stage in the same pipeline (`400 MOVE_TARGET_REQUIRED` / `MOVE_TARGET_INVALID`); archives need `leads.view` at `all` (`403 NEEDS_FULL_VISIBILITY`); the default pipeline can't be archived (`400 DEFAULT_PIPELINE`); a pipeline with live leads can't be archived (`409 PIPELINE_HAS_LEADS`)

- [ ] **Step 1: Write the failing tests**

`apps/api/src/modules/pipelines/pipelines.test.ts`:
```ts
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
let admin: AuthedClient;
beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
});
afterAll(async () => h.close());

describe("pipelines & stages (report §6)", () => {
  it("setup's preset is visible to anyone who can see leads, in stage order", async () => {
    const rep = await h.signIn(await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] }));
    const { pipelines } = (await rep.inject({ method: "GET", url: "/api/v1/pipelines" })).json();
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0]).toMatchObject({ name: "Coaching sales", isDefault: true });
    expect(pipelines[0].stages.map((s: { name: string }) => s.name)).toEqual(["New", "Message sent", "Replied", "Call booked", "Call done", "Follow-up later", "Won", "Lost"]);
  });

  it("a new pipeline starts with New / Won / Lost; stages can be added, recoloured and reordered", async () => {
    const p = (await admin.inject({ method: "POST", url: "/api/v1/pipelines", payload: { name: "Corporate" } })).json().pipeline;
    expect(p.stages.map((s: { kind: string }) => s.kind)).toEqual(["open", "won", "lost"]);
    const s = (await admin.inject({ method: "POST", url: `/api/v1/pipelines/${p.id}/stages`, payload: { name: "Pitched", kind: "open", color: "warn", winProbability: 50 } })).json().stage;
    expect(s).toMatchObject({ name: "Pitched", position: 3, color: "warn", winProbability: 50 });
    const order = [s.id, ...p.stages.map((x: { id: string }) => x.id)];
    const re = (await admin.inject({ method: "PUT", url: `/api/v1/pipelines/${p.id}/stage-order`, payload: { stageIds: order } })).json().pipeline;
    expect(re.stages.map((x: { id: string }) => x.id)).toEqual(order);
    expect((await admin.inject({ method: "PUT", url: `/api/v1/pipelines/${p.id}/stage-order`, payload: { stageIds: order.slice(1) } })).json().error.code).toBe("STAGE_ORDER_INCOMPLETE");
  });

  it("keeps at least one won and one lost stage", async () => {
    const p = (await admin.inject({ method: "POST", url: "/api/v1/pipelines", payload: { name: "Tiny" } })).json().pipeline;
    const won = p.stages.find((s: { kind: string }) => s.kind === "won");
    expect((await admin.inject({ method: "POST", url: `/api/v1/stages/${won.id}/archive`, payload: {} })).json().error.code).toBe("STAGE_KINDS_REQUIRED");
    expect((await admin.inject({ method: "PATCH", url: `/api/v1/stages/${won.id}`, payload: { kind: "open" } })).json().error.code).toBe("STAGE_KINDS_REQUIRED");
  });

  it("archiving a stage with leads moves them to an open stage, with history", async () => {
    const cfg = await h.config();
    const owner = await h.seedUser({ grants: [] });
    const lead = await h.seedLead({ ownerId: owner.id, stage: "Replied" });
    const noTarget = await admin.inject({ method: "POST", url: `/api/v1/stages/${cfg.stages.Replied}/archive`, payload: {} });
    expect(noTarget.json().error.code).toBe("MOVE_TARGET_REQUIRED");
    const toWon = await admin.inject({ method: "POST", url: `/api/v1/stages/${cfg.stages.Replied}/archive`, payload: { moveToStageId: cfg.stages.Won } });
    expect(toWon.json().error.code).toBe("MOVE_TARGET_INVALID");
    const ok = await admin.inject({ method: "POST", url: `/api/v1/stages/${cfg.stages.Replied}/archive`, payload: { moveToStageId: cfg.stages["Message sent"] } });
    expect(ok.statusCode).toBe(204);
    const { rows } = await h.ownerPool.query("SELECT 1 FROM stages WHERE id = $1 AND archived_at IS NOT NULL", [cfg.stages.Replied]);
    expect(rows).toHaveLength(1);
    const moved = await admin.inject({ method: "GET", url: `/api/v1/leads/${lead}` });
    expect(moved.json().lead.stageId).toBe(cfg.stages["Message sent"]);
  });

  it("archive needs full lead visibility, so a partial view can't hide leads", async () => {
    const cfg = await h.config();
    const pm = await h.signIn(await h.seedUser({ grants: [{ key: "pipelines.manage", scope: null }, { key: "leads.view", scope: "own" }] }));
    const r = await pm.inject({ method: "POST", url: `/api/v1/stages/${cfg.stages["Call done"]}/archive`, payload: { moveToStageId: cfg.stages.New } });
    expect(r.json().error.code).toBe("NEEDS_FULL_VISIBILITY");
  });

  it("the default pipeline can't be archived; an empty non-default one can", async () => {
    const cfg = await h.config();
    expect((await admin.inject({ method: "POST", url: `/api/v1/pipelines/${cfg.pipelineId}/archive` })).json().error.code).toBe("DEFAULT_PIPELINE");
    const p = (await admin.inject({ method: "POST", url: "/api/v1/pipelines", payload: { name: "Temp" } })).json().pipeline;
    expect((await admin.inject({ method: "POST", url: `/api/v1/pipelines/${p.id}/archive` })).statusCode).toBe(204);
  });
});
```
In `setup.test.ts`, extend the success test:
```ts
    const stages = (await h.pool.query("SELECT s.name FROM stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE p.is_default ORDER BY s.position")).rows.map((r) => r.name);
    expect(stages[0]).toBe("New");
    expect((await h.pool.query("SELECT key FROM field_definitions WHERE NOT is_core ORDER BY key")).rows.map((r) => r.key)).toEqual(["handled_by", "struggles"]);
```

- [ ] **Step 2: Run to verify they fail**

Run: `scripts/dev.sh run pnpm vitest run apps/api/src/modules/pipelines apps/api/src/modules/setup`
Expected: FAIL (routes missing; nothing seeded).

- [ ] **Step 3: Implement**

`apps/api/src/modules/pipelines/seed.ts`:
```ts
import { CORE_FIELDS, PRESETS, newId, type PresetKey } from "@lume/core";
import { schema } from "@lume/db";
import type { Db } from "../../db/context";

/** First-run configuration from a code-defined preset (report §5.2 industry_presets). One transaction. */
export async function seedConfiguration(db: Db, presetKey: PresetKey): Promise<void> {
  const preset = PRESETS[presetKey];
  await db.insert(schema.fieldDefinitions).values([
    ...CORE_FIELDS.map((f, i) => ({ id: newId(), key: f.key, label: f.label, type: f.type, isCore: true, isRequired: f.isRequired, position: i })),
    ...preset.fields.map((f, i) => ({
      id: newId(),
      key: f.key,
      label: f.label,
      type: f.type,
      options: (f.options ?? []).map((o) => ({ id: newId(), label: o.label, ...(o.color ? { color: o.color } : {}) })),
      position: CORE_FIELDS.length + i,
    })),
  ]);
  const pipelineId = newId();
  await db.insert(schema.pipelines).values({ id: pipelineId, name: preset.pipeline.name, isDefault: true });
  await db.insert(schema.stages).values(
    preset.pipeline.stages.map((s, i) => ({ id: newId(), pipelineId, name: s.name, kind: s.kind, color: s.color, winProbability: s.winProbability, position: i })),
  );
  if (preset.lostReasons.length) {
    await db.insert(schema.lostReasons).values(preset.lostReasons.map((label, i) => ({ id: newId(), label, position: i })));
  }
}
```

In `apps/api/src/modules/setup/service.ts`, delete `presetAppliers` and its loop. After inserting settings, call `await seedConfiguration(req.db, input.preset);` (import from `../pipelines/seed`).

`apps/api/src/modules/pipelines/service.ts`:
```ts
import { and, asc, eq, inArray, isNull, max, ne, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { newId, scopeOf } from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { badRequest, conflict, forbidden, notFound } from "../../http/errors";

type StageRow = typeof schema.stages.$inferSelect;
export type StageInput = {
  name?: string;
  kind?: "open" | "won" | "lost";
  color?: string;
  winProbability?: number | null;
  slaHours?: number | null;
  requiredFieldIds?: string[];
};

const stageView = (s: StageRow) => ({
  id: s.id,
  name: s.name,
  color: s.color,
  position: s.position,
  kind: s.kind,
  winProbability: s.winProbability,
  slaHours: s.slaHours,
  requiredFieldIds: s.requiredFieldIds,
});

async function livePipeline(req: FastifyRequest, id: string) {
  const [p] = await req.db.select().from(schema.pipelines).where(and(eq(schema.pipelines.id, id), isNull(schema.pipelines.archivedAt)));
  if (!p) throw notFound("PIPELINE_NOT_FOUND", "Pipeline not found");
  return p;
}

async function liveStage(req: FastifyRequest, id: string) {
  const [s] = await req.db.select().from(schema.stages).where(and(eq(schema.stages.id, id), isNull(schema.stages.archivedAt)));
  if (!s) throw notFound("STAGE_NOT_FOUND", "Stage not found");
  return s;
}

const liveStages = (req: FastifyRequest, pipelineId: string) =>
  req.db
    .select()
    .from(schema.stages)
    .where(and(eq(schema.stages.pipelineId, pipelineId), isNull(schema.stages.archivedAt)))
    .orderBy(asc(schema.stages.position), asc(schema.stages.createdAt));

async function pipelineView(req: FastifyRequest, id: string) {
  const p = await livePipeline(req, id);
  return { id: p.id, name: p.name, isDefault: p.isDefault, position: p.position, stages: (await liveStages(req, id)).map(stageView) };
}

/** Anything that must account for every lead needs to see every lead (RLS would silently hide some). */
function assertFullVisibility(req: FastifyRequest) {
  if (scopeOf(req.actor!, "leads.view") !== "all") {
    throw forbidden("NEEDS_FULL_VISIBILITY", "This needs access to all leads");
  }
}

function assertKinds(stages: { kind: string }[]) {
  const kinds = new Set(stages.map((s) => s.kind));
  if (!kinds.has("won") || !kinds.has("lost")) throw badRequest("STAGE_KINDS_REQUIRED", "A pipeline needs at least one Won and one Lost stage");
}

async function assertFieldsExist(req: FastifyRequest, ids: string[] | undefined) {
  if (!ids?.length) return;
  const found = await req.db
    .select({ id: schema.fieldDefinitions.id })
    .from(schema.fieldDefinitions)
    .where(and(inArray(schema.fieldDefinitions.id, ids), isNull(schema.fieldDefinitions.archivedAt)));
  if (found.length !== new Set(ids).size) throw badRequest("UNKNOWN_FIELD", "One of those fields doesn't exist");
}

export async function listPipelines(req: FastifyRequest) {
  const ps = await req.db.select().from(schema.pipelines).where(isNull(schema.pipelines.archivedAt)).orderBy(asc(schema.pipelines.position), asc(schema.pipelines.createdAt));
  const out = [];
  for (const p of ps) out.push(await pipelineView(req, p.id)); // one connection: sequential
  return { pipelines: out };
}

export async function createPipeline(req: FastifyRequest, name: string) {
  const [dup] = await req.db.select({ id: schema.pipelines.id }).from(schema.pipelines).where(and(eq(schema.pipelines.name, name), isNull(schema.pipelines.archivedAt)));
  if (dup) throw conflict("PIPELINE_EXISTS", "A pipeline with that name already exists");
  const [hasDefault] = await req.db.select({ id: schema.pipelines.id }).from(schema.pipelines).where(and(eq(schema.pipelines.isDefault, true), isNull(schema.pipelines.archivedAt)));
  const [{ top } = { top: null }] = await req.db.select({ top: max(schema.pipelines.position) }).from(schema.pipelines);
  const id = newId();
  await req.db.insert(schema.pipelines).values({ id, name, isDefault: !hasDefault, position: (top ?? -1) + 1 });
  await req.db.insert(schema.stages).values([
    { id: newId(), pipelineId: id, name: "New", kind: "open", color: "accent", position: 0, winProbability: 10 },
    { id: newId(), pipelineId: id, name: "Won", kind: "won", color: "ok", position: 1, winProbability: 100 },
    { id: newId(), pipelineId: id, name: "Lost", kind: "lost", color: "danger", position: 2, winProbability: 0 },
  ]);
  await audit(req, { action: "pipeline.created", entityType: "pipeline", entityId: id, diff: { name } });
  return { pipeline: await pipelineView(req, id) };
}

export async function updatePipeline(req: FastifyRequest, id: string, patch: { name?: string; isDefault?: boolean; position?: number }) {
  const p = await livePipeline(req, id);
  if (patch.isDefault === false && p.isDefault) throw badRequest("DEFAULT_PIPELINE", "Make another pipeline the default instead");
  if (patch.isDefault) await req.db.update(schema.pipelines).set({ isDefault: false }).where(and(eq(schema.pipelines.isDefault, true), ne(schema.pipelines.id, id)));
  if (Object.keys(patch).length) await req.db.update(schema.pipelines).set(patch).where(eq(schema.pipelines.id, id));
  await audit(req, { action: "pipeline.updated", entityType: "pipeline", entityId: id, diff: patch });
  return { pipeline: await pipelineView(req, id) };
}

export async function archivePipeline(req: FastifyRequest, id: string) {
  const p = await livePipeline(req, id);
  if (p.isDefault) throw badRequest("DEFAULT_PIPELINE", "The default pipeline can't be archived");
  assertFullVisibility(req);
  const [{ n }] = (await req.db.execute(sql`SELECT count(*)::int AS n FROM leads WHERE pipeline_id = ${id} AND deleted_at IS NULL`)).rows as [{ n: number }];
  if (n > 0) throw conflict("PIPELINE_HAS_LEADS", `Move its ${n} leads first`);
  const now = new Date();
  await req.db.update(schema.stages).set({ archivedAt: now }).where(and(eq(schema.stages.pipelineId, id), isNull(schema.stages.archivedAt)));
  await req.db.update(schema.pipelines).set({ archivedAt: now }).where(eq(schema.pipelines.id, id));
  await audit(req, { action: "pipeline.archived", entityType: "pipeline", entityId: id });
}

export async function createStage(req: FastifyRequest, pipelineId: string, input: StageInput & { name: string; kind: "open" | "won" | "lost" }) {
  await livePipeline(req, pipelineId);
  await assertFieldsExist(req, input.requiredFieldIds);
  const current = await liveStages(req, pipelineId);
  if (current.some((s) => s.name.toLowerCase() === input.name.toLowerCase())) throw conflict("STAGE_EXISTS", "A stage with that name already exists");
  const id = newId();
  await req.db.insert(schema.stages).values({ id, pipelineId, position: current.length ? Math.max(...current.map((s) => s.position)) + 1 : 0, ...input });
  await audit(req, { action: "stage.created", entityType: "stage", entityId: id, diff: { pipelineId, name: input.name, kind: input.kind } });
  return { stage: stageView(await liveStage(req, id)) };
}

export async function updateStage(req: FastifyRequest, id: string, patch: StageInput) {
  const s = await liveStage(req, id);
  await assertFieldsExist(req, patch.requiredFieldIds);
  if (patch.kind && patch.kind !== s.kind) {
    const others = (await liveStages(req, s.pipelineId)).map((x) => (x.id === id ? { kind: patch.kind! } : x));
    assertKinds(others);
  }
  if (Object.keys(patch).length) await req.db.update(schema.stages).set(patch).where(eq(schema.stages.id, id));
  await audit(req, { action: "stage.updated", entityType: "stage", entityId: id, diff: patch });
  return { stage: stageView(await liveStage(req, id)) };
}

export async function reorderStages(req: FastifyRequest, pipelineId: string, stageIds: string[]) {
  const current = await liveStages(req, pipelineId);
  const want = new Set(stageIds);
  if (want.size !== stageIds.length || current.length !== stageIds.length || current.some((s) => !want.has(s.id))) {
    throw badRequest("STAGE_ORDER_INCOMPLETE", "List every active stage of the pipeline exactly once");
  }
  for (const [i, sid] of stageIds.entries()) await req.db.update(schema.stages).set({ position: i }).where(eq(schema.stages.id, sid));
  await audit(req, { action: "stage.reordered", entityType: "pipeline", entityId: pipelineId, diff: { stageIds } });
  return { pipeline: await pipelineView(req, pipelineId) };
}

export async function archiveStage(req: FastifyRequest, id: string, moveToStageId?: string) {
  const s = await liveStage(req, id);
  const siblings = await liveStages(req, s.pipelineId);
  assertKinds(siblings.filter((x) => x.id !== id));
  assertFullVisibility(req);
  const [{ n }] = (await req.db.execute(sql`SELECT count(*)::int AS n FROM leads WHERE stage_id = ${id} AND deleted_at IS NULL`)).rows as [{ n: number }];
  if (n > 0) {
    if (!moveToStageId) throw badRequest("MOVE_TARGET_REQUIRED", `Choose where its ${n} leads should go`);
    const target = siblings.find((x) => x.id === moveToStageId);
    if (!target || target.id === id || target.kind !== "open") {
      throw badRequest("MOVE_TARGET_INVALID", "Move leads to another open stage of the same pipeline");
    }
    const actorId = req.actor!.userId;
    // History first, while the leads still sit in the old stage; then move them.
    await req.db.execute(sql`
      INSERT INTO lead_stage_history (lead_id, from_stage_id, to_stage_id, pipeline_id, changed_by)
      SELECT id, stage_id, ${target.id}, pipeline_id, ${actorId} FROM leads WHERE stage_id = ${id} AND deleted_at IS NULL`);
    await req.db.execute(sql`
      UPDATE leads SET stage_id = ${target.id}, stage_entered_at = now(), version = version + 1
       WHERE stage_id = ${id} AND deleted_at IS NULL`);
  }
  await req.db.update(schema.stages).set({ archivedAt: new Date() }).where(eq(schema.stages.id, id));
  await audit(req, { action: "stage.archived", entityType: "stage", entityId: id, diff: { movedLeads: n, moveToStageId: moveToStageId ?? null } });
}

```

`apps/api/src/modules/pipelines/routes.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as svc from "./service";

const manage = { permission: "pipelines.manage" as const };
const params = z.object({ id: z.uuid() });
const COLORS = ["accent", "ok", "warn", "danger", "meet", "cyan", "neutral"] as const;
const stageBody = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(["open", "won", "lost"]),
  color: z.enum(COLORS).optional(),
  winProbability: z.number().min(0).max(100).nullable().optional(),
  slaHours: z.number().int().min(1).max(24 * 365).nullable().optional(),
  requiredFieldIds: z.array(z.uuid()).max(30).optional(),
});

export async function pipelineRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/pipelines", { config: { permission: "leads.view" } }, (req) => svc.listPipelines(req));
  r.post("/api/v1/pipelines", { config: manage, schema: { body: z.object({ name: z.string().trim().min(1).max(60) }) } }, async (req, reply) =>
    reply.code(201).send(await svc.createPipeline(req, req.body.name)),
  );
  r.patch(
    "/api/v1/pipelines/:id",
    { config: manage, schema: { params, body: z.object({ name: z.string().trim().min(1).max(60).optional(), isDefault: z.literal(true).optional(), position: z.number().int().min(0).max(1000).optional() }).strict() } },
    (req) => svc.updatePipeline(req, req.params.id, req.body),
  );
  r.post("/api/v1/pipelines/:id/archive", { config: manage, schema: { params } }, async (req, reply) => {
    await svc.archivePipeline(req, req.params.id);
    return reply.code(204).send();
  });
  r.post("/api/v1/pipelines/:id/stages", { config: manage, schema: { params, body: stageBody } }, async (req, reply) =>
    reply.code(201).send(await svc.createStage(req, req.params.id, req.body)),
  );
  r.put("/api/v1/pipelines/:id/stage-order", { config: manage, schema: { params, body: z.object({ stageIds: z.array(z.uuid()).min(1).max(50) }) } }, (req) =>
    svc.reorderStages(req, req.params.id, req.body.stageIds),
  );
  r.patch("/api/v1/stages/:id", { config: manage, schema: { params, body: stageBody.partial().strict() } }, (req) => svc.updateStage(req, req.params.id, req.body));
  r.post("/api/v1/stages/:id/archive", { config: manage, schema: { params, body: z.object({ moveToStageId: z.uuid().optional() }) } }, async (req, reply) => {
    await svc.archiveStage(req, req.params.id, req.body.moveToStageId);
    return reply.code(204).send();
  });
}
```
Register `pipelineRoutes` in `app.ts`. The archive test reads a lead through `GET /leads/:id`, which Task 6 adds. Until then, mark that one assertion `it.todo`-free by querying `h.pool` inside `withAllScope`. Alternatively, keep the assertion as written and run that file again after Task 6. **Keep it as written;** Task 6 Step 4 re-runs this file.

- [ ] **Step 4: Run to verify**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/api/src/modules/pipelines apps/api/src/modules/setup'`
Expected: all but the "archiving a stage with leads" test pass. That test's last assertion needs `GET /leads/:id` (Task 6) and fails now with a 404 on that call. Proceed; Task 6 re-runs it.
Then: `scripts/dev.sh run bash -c 'pnpm lint && pnpm typecheck'`.

- [ ] **Step 5: Commit and push**

Mark that single test `it.skip` with the comment `// un-skipped in Task 6 (needs GET /leads/:id)` so the full gate is green, then:
```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(api): pipelines and stages with won/lost invariants, reorder, archive-with-move; presets seeded at setup

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 5: Fields, lost reasons, tags, products, role field access

**Files:**
- Create: `apps/api/src/modules/fields/{routes,service}.ts`, `apps/api/src/modules/fields/fields.test.ts`, `apps/api/src/modules/catalog/{routes,service}.ts`, `apps/api/src/modules/catalog/catalog.test.ts`, `apps/api/src/modules/roles/field-access.ts`
- Modify: `apps/api/src/modules/roles/routes.ts`, `apps/api/src/modules/roles/roles.test.ts`, `apps/api/src/app.ts`

**Interfaces:**
- Produces:
  - `GET /fields` (leads.view) → `{ fields: FieldView[] }`, where `FieldView = { id, key, label, type, options, isCore, isRequired, isSearchable, position, archived, access }` (`access` is the caller's own)
  - `POST /fields` (fields.manage) `{ key, label, type, options?, isRequired?, isSearchable? }` → 201
  - `PATCH /fields/:id` `{ label?, options?, isRequired?, isSearchable?, position?, type? }` (`type` → `400 TYPE_IMMUTABLE`); `POST /fields/:id/archive` → 204
  - `GET/POST /lost-reasons`, `PATCH /lost-reasons/:id`, `POST /lost-reasons/:id/archive` (reads leads.view, writes pipelines.manage)
  - `GET/POST /tags`, `PATCH /tags/:id`, `DELETE /tags/:id` (writes settings.manage)
  - `GET/POST /products`, `PATCH /products/:id`, `POST /products/:id/archive` (writes settings.manage)
  - `PUT /roles/:id/field-access` (roles.manage) `{ entries: { fieldId, access }[] }` → `{ entries }` (replaces the role's rows; `edit` rows are simply omitted)

- [ ] **Step 1: Write the failing tests**

`apps/api/src/modules/fields/fields.test.ts`:
```ts
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
let admin: AuthedClient;
beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
});
afterAll(async () => h.close());

describe("field definitions (report §6)", () => {
  it("creates a custom field with stable option ids and bumps the definitions version", async () => {
    const v0 = (await h.pool.query("SELECT field_defs_version v FROM settings")).rows[0].v;
    const f = (await admin.inject({ method: "POST", url: "/api/v1/fields", payload: { key: "budget_band", label: "Budget band", type: "select", options: [{ label: "Low" }, { label: "High", color: "ok" }] } })).json().field;
    expect(f).toMatchObject({ key: "budget_band", type: "select", isCore: false });
    expect(f.options).toHaveLength(2);
    expect((await h.pool.query("SELECT field_defs_version v FROM settings")).rows[0].v).toBe(v0 + 1);

    // Renaming an option keeps its id; dropping one from the list archives it instead of deleting it.
    const [low, high] = f.options;
    const patched = (await admin.inject({ method: "PATCH", url: `/api/v1/fields/${f.id}`, payload: { options: [{ id: low.id, label: "Small" }, { label: "Medium" }] } })).json().field;
    expect(patched.options.find((o: { id: string }) => o.id === low.id).label).toBe("Small");
    expect(patched.options.find((o: { id: string }) => o.id === high.id).archived).toBe(true);
    expect(patched.options).toHaveLength(3);
  });

  it("refuses core keys, duplicates, type changes and archiving core fields", async () => {
    expect((await admin.inject({ method: "POST", url: "/api/v1/fields", payload: { key: "phone", label: "x", type: "text" } })).statusCode).toBe(409);
    expect((await admin.inject({ method: "POST", url: "/api/v1/fields", payload: { key: "struggles", label: "x", type: "text" } })).statusCode).toBe(409);
    const cfg = await h.config();
    expect((await admin.inject({ method: "PATCH", url: `/api/v1/fields/${cfg.fields.struggles}`, payload: { type: "text" } })).json().error.code).toBe("TYPE_IMMUTABLE");
    expect((await admin.inject({ method: "POST", url: `/api/v1/fields/${cfg.fields.phone}/archive` })).json().error.code).toBe("CORE_FIELD");
    expect((await admin.inject({ method: "PATCH", url: `/api/v1/fields/${cfg.fields.phone}`, payload: { label: "Mobile" } })).json().field.label).toBe("Mobile");
  });

  it("hides fields a role can't see from that role's field list", async () => {
    const cfg = await h.config();
    const rep = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] });
    const { rows: [role] } = await h.pool.query("SELECT role_id FROM user_roles WHERE user_id = $1", [rep.id]);
    const put = await admin.inject({ method: "PUT", url: `/api/v1/roles/${role.role_id}/field-access`, payload: { entries: [{ fieldId: cfg.fields.struggles, access: "hidden" }, { fieldId: cfg.fields.phone, access: "view" }] } });
    expect(put.statusCode).toBe(200);
    await h.waitForRbacNotify();
    const list = (await (await h.signIn(rep)).inject({ method: "GET", url: "/api/v1/fields" })).json().fields;
    expect(list.some((f: { key: string }) => f.key === "struggles")).toBe(false);
    expect(list.find((f: { key: string }) => f.key === "phone").access).toBe("view");
  });

  it("nobody can grant field access they don't hold themselves", async () => {
    const cfg = await h.config();
    const rm = await h.seedUser({ grants: [{ key: "roles.manage", scope: null }], totp: true });
    const { rows: [own] } = await h.pool.query("SELECT role_id FROM user_roles WHERE user_id = $1", [rm.id]);
    await admin.inject({ method: "PUT", url: `/api/v1/roles/${own.role_id}/field-access`, payload: { entries: [{ fieldId: cfg.fields.handled_by, access: "view" }] } });
    await h.waitForRbacNotify();
    const { rows: [target] } = await h.pool.query("INSERT INTO roles (id, name) VALUES (gen_random_uuid(), 'Target') RETURNING id");
    const c = await h.signIn(rm);
    const r = await c.inject({ method: "PUT", url: `/api/v1/roles/${target.id}/field-access`, payload: { entries: [{ fieldId: cfg.fields.handled_by, access: "edit" }] } });
    // "edit" is the default, so granting it to Target = no row; but rm itself only has view → still escalation
    expect(r.json().error.code).toBe("ESCALATION");
  });
});
```

`apps/api/src/modules/catalog/catalog.test.ts`:
```ts
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
let admin: AuthedClient;
beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
});
afterAll(async () => h.close());

describe("lost reasons, tags, products", () => {
  it("lost reasons come from the preset and can be added, renamed and archived", async () => {
    const list = (await admin.inject({ method: "GET", url: "/api/v1/lost-reasons" })).json().lostReasons;
    expect(list.map((r: { label: string }) => r.label)[0]).toBe("Not interested");
    const r = (await admin.inject({ method: "POST", url: "/api/v1/lost-reasons", payload: { label: "Moved away" } })).json().lostReason;
    await admin.inject({ method: "PATCH", url: `/api/v1/lost-reasons/${r.id}`, payload: { label: "Relocated" } });
    expect((await admin.inject({ method: "POST", url: `/api/v1/lost-reasons/${r.id}/archive` })).statusCode).toBe(204);
    const after = (await admin.inject({ method: "GET", url: "/api/v1/lost-reasons" })).json().lostReasons;
    expect(after.some((x: { label: string }) => x.label === "Relocated")).toBe(false);
  });

  it("tags are unique case-insensitively and deletable", async () => {
    const t = (await admin.inject({ method: "POST", url: "/api/v1/tags", payload: { label: "VIP", color: "warn" } })).json().tag;
    expect((await admin.inject({ method: "POST", url: "/api/v1/tags", payload: { label: "vip" } })).statusCode).toBe(409);
    expect((await admin.inject({ method: "DELETE", url: `/api/v1/tags/${t.id}` })).statusCode).toBe(204);
  });

  it("products carry an optional default value and currency", async () => {
    const p = (await admin.inject({ method: "POST", url: "/api/v1/products", payload: { name: "12-week program", defaultValue: 4500, currency: "AED" } })).json().product;
    expect(p).toMatchObject({ name: "12-week program", defaultValue: 4500, currency: "AED" });
    expect((await admin.inject({ method: "POST", url: `/api/v1/products/${p.id}/archive` })).statusCode).toBe(204);
  });

  it("anyone who can see leads can read the lists; only managers can change them", async () => {
    const rep = await h.signIn(await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] }));
    expect((await rep.inject({ method: "GET", url: "/api/v1/tags" })).statusCode).toBe(200);
    expect((await rep.inject({ method: "POST", url: "/api/v1/tags", payload: { label: "Nope" } })).statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `scripts/dev.sh run pnpm vitest run apps/api/src/modules/fields apps/api/src/modules/catalog`
Expected: FAIL (404s).

- [ ] **Step 3: Implement**

`apps/api/src/modules/fields/service.ts`:
```ts
import { and, eq, max } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { CORE_FIELD_KEYS, can, fieldAccessOf, newId, type FieldType } from "@lume/core";
import { schema, type FieldOptionRow } from "@lume/db";
import { audit } from "../../audit/audit";
import { badRequest, conflict, notFound } from "../../http/errors";
import { bumpFieldDefs } from "../../leads/fields";

const OPTION_TYPES: FieldType[] = ["select", "multi_select"];
type FieldRow = typeof schema.fieldDefinitions.$inferSelect;
export type OptionInput = { id?: string; label: string; color?: string };

const view = (f: FieldRow, access: string) => ({
  id: f.id,
  key: f.key,
  label: f.label,
  type: f.type,
  options: f.options,
  isCore: f.isCore,
  isRequired: f.isRequired,
  isSearchable: f.isSearchable,
  position: f.position,
  archived: f.archivedAt !== null,
  access,
});

async function field(req: FastifyRequest, id: string) {
  const [f] = await req.db.select().from(schema.fieldDefinitions).where(eq(schema.fieldDefinitions.id, id));
  if (!f) throw notFound("FIELD_NOT_FOUND", "Field not found");
  return f;
}

/** Existing options keep their ids; options left out of the list are archived, never deleted (data refers to them). */
function mergeOptions(existing: FieldOptionRow[], incoming: OptionInput[]): FieldOptionRow[] {
  const byId = new Map(existing.map((o) => [o.id, o]));
  const seen = new Set<string>();
  const out: FieldOptionRow[] = [];
  for (const o of incoming) {
    if (o.id && !byId.has(o.id)) throw badRequest("UNKNOWN_OPTION", "One of those options doesn't exist");
    const id = o.id ?? newId();
    seen.add(id);
    out.push({ id, label: o.label, ...(o.color ? { color: o.color } : {}) });
  }
  for (const o of existing) if (!seen.has(o.id)) out.push({ ...o, archived: true });
  const live = out.filter((o) => !o.archived).map((o) => o.label.toLowerCase());
  if (new Set(live).size !== live.length) throw badRequest("DUPLICATE_OPTION", "Two options have the same name");
  return out;
}

export async function listFields(req: FastifyRequest) {
  const actor = req.actor!;
  const manager = can(actor, "fields.manage");
  const rows = await req.db.select().from(schema.fieldDefinitions).orderBy(schema.fieldDefinitions.position);
  return {
    fields: rows
      .map((f) => view(f, fieldAccessOf(actor.fieldAccess, f.id)))
      .filter((f) => manager || (f.access !== "hidden" && !f.archived)),
  };
}

export async function createField(
  req: FastifyRequest,
  input: { key: string; label: string; type: FieldType; options?: OptionInput[]; isRequired?: boolean; isSearchable?: boolean },
) {
  if (CORE_FIELD_KEYS.has(input.key)) throw conflict("FIELD_EXISTS", "That key belongs to a built-in field");
  const [dup] = await req.db.select({ id: schema.fieldDefinitions.id }).from(schema.fieldDefinitions).where(eq(schema.fieldDefinitions.key, input.key));
  if (dup) throw conflict("FIELD_EXISTS", "A field with that key already exists");
  if (!OPTION_TYPES.includes(input.type) && input.options?.length) throw badRequest("OPTIONS_NOT_ALLOWED", "Only select fields have options");
  const [{ top } = { top: null }] = await req.db.select({ top: max(schema.fieldDefinitions.position) }).from(schema.fieldDefinitions);
  const id = newId();
  await req.db.insert(schema.fieldDefinitions).values({
    id,
    key: input.key,
    label: input.label,
    type: input.type,
    options: mergeOptions([], input.options ?? []),
    isRequired: input.isRequired ?? false,
    isSearchable: input.isSearchable ?? false,
    position: (top ?? -1) + 1,
  });
  await bumpFieldDefs(req);
  await audit(req, { action: "field.created", entityType: "field", entityId: id, diff: { key: input.key, type: input.type } });
  return { field: view(await field(req, id), "edit") };
}

export async function updateField(
  req: FastifyRequest,
  id: string,
  patch: { label?: string; options?: OptionInput[]; isRequired?: boolean; isSearchable?: boolean; position?: number; type?: string },
) {
  const f = await field(req, id);
  if (patch.type !== undefined && patch.type !== f.type) throw badRequest("TYPE_IMMUTABLE", "A field's type can't be changed yet");
  if (f.archivedAt) throw badRequest("FIELD_ARCHIVED", "Archived fields can't be edited");
  if (f.isCore && (patch.options || patch.isRequired !== undefined || patch.isSearchable !== undefined)) {
    throw badRequest("CORE_FIELD", "Built-in fields can only be renamed or moved");
  }
  if (patch.options && !OPTION_TYPES.includes(f.type)) throw badRequest("OPTIONS_NOT_ALLOWED", "Only select fields have options");
  const set: Partial<typeof schema.fieldDefinitions.$inferInsert> = {};
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.position !== undefined) set.position = patch.position;
  if (patch.isRequired !== undefined) set.isRequired = patch.isRequired;
  if (patch.isSearchable !== undefined) set.isSearchable = patch.isSearchable;
  if (patch.options) set.options = mergeOptions(f.options, patch.options);
  if (Object.keys(set).length) {
    await req.db.update(schema.fieldDefinitions).set(set).where(eq(schema.fieldDefinitions.id, id));
    await bumpFieldDefs(req);
  }
  await audit(req, { action: "field.updated", entityType: "field", entityId: id, diff: { fields: Object.keys(set) } });
  return { field: view(await field(req, id), fieldAccessOf(req.actor!.fieldAccess, id)) };
}

export async function archiveField(req: FastifyRequest, id: string) {
  const f = await field(req, id);
  if (f.isCore) throw badRequest("CORE_FIELD", "Built-in fields can be hidden per role, not archived");
  if (f.archivedAt) return;
  await req.db.update(schema.fieldDefinitions).set({ archivedAt: new Date() }).where(and(eq(schema.fieldDefinitions.id, id)));
  await bumpFieldDefs(req);
  await audit(req, { action: "field.archived", entityType: "field", entityId: id, diff: { key: f.key } });
}
```

`apps/api/src/modules/fields/routes.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { FIELD_TYPES } from "@lume/core";
import * as svc from "./service";

const manage = { permission: "fields.manage" as const };
const params = z.object({ id: z.uuid() });
const COLORS = ["accent", "ok", "warn", "danger", "meet", "cyan", "neutral"] as const;
const option = z.object({ id: z.string().min(1).max(64).optional(), label: z.string().trim().min(1).max(60), color: z.enum(COLORS).optional() });
const label = z.string().trim().min(1).max(60);

export async function fieldRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/fields", { config: { permission: "leads.view" } }, (req) => svc.listFields(req));
  r.post(
    "/api/v1/fields",
    {
      config: manage,
      schema: {
        body: z.object({
          key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
          label,
          type: z.enum(FIELD_TYPES),
          options: z.array(option.omit({ id: true })).max(100).optional(),
          isRequired: z.boolean().optional(),
          isSearchable: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => reply.code(201).send(await svc.createField(req, req.body)),
  );
  r.patch(
    "/api/v1/fields/:id",
    {
      config: manage,
      schema: {
        params,
        body: z
          .object({
            label: label.optional(),
            options: z.array(option).max(100).optional(),
            isRequired: z.boolean().optional(),
            isSearchable: z.boolean().optional(),
            position: z.number().int().min(0).max(1000).optional(),
            type: z.string().optional(),
          })
          .strict(),
      },
    },
    (req) => svc.updateField(req, req.params.id, req.body),
  );
  r.post("/api/v1/fields/:id/archive", { config: manage, schema: { params } }, async (req, reply) => {
    await svc.archiveField(req, req.params.id);
    return reply.code(204).send();
  });
}
```

`apps/api/src/modules/catalog/service.ts`:
```ts
import { and, asc, eq, isNull, max, ne } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { newId } from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { conflict, notFound } from "../../http/errors";

// ── Lost reasons ───────────────────────────────────────────────────────────────
const reasonView = (r: typeof schema.lostReasons.$inferSelect) => ({ id: r.id, label: r.label, position: r.position });

export async function listLostReasons(req: FastifyRequest) {
  const rows = await req.db.select().from(schema.lostReasons).where(isNull(schema.lostReasons.archivedAt)).orderBy(asc(schema.lostReasons.position));
  return { lostReasons: rows.map(reasonView) };
}

async function assertReasonLabelFree(req: FastifyRequest, label: string, exceptId?: string) {
  const [dup] = await req.db.select({ id: schema.lostReasons.id }).from(schema.lostReasons).where(and(eq(schema.lostReasons.label, label), isNull(schema.lostReasons.archivedAt)));
  if (dup && dup.id !== exceptId) throw conflict("LOST_REASON_EXISTS", "That reason already exists");
}

export async function createLostReason(req: FastifyRequest, label: string) {
  await assertReasonLabelFree(req, label);
  const [{ top } = { top: null }] = await req.db.select({ top: max(schema.lostReasons.position) }).from(schema.lostReasons);
  const id = newId();
  const [row] = await req.db.insert(schema.lostReasons).values({ id, label, position: (top ?? -1) + 1 }).returning();
  await audit(req, { action: "lost_reason.created", entityType: "lost_reason", entityId: id, diff: { label } });
  return { lostReason: reasonView(row!) };
}

export async function updateLostReason(req: FastifyRequest, id: string, patch: { label?: string; position?: number }) {
  if (patch.label) await assertReasonLabelFree(req, patch.label, id);
  const [row] = await req.db
    .update(schema.lostReasons)
    .set(patch)
    .where(and(eq(schema.lostReasons.id, id), isNull(schema.lostReasons.archivedAt)))
    .returning();
  if (!row) throw notFound("LOST_REASON_NOT_FOUND", "Lost reason not found");
  await audit(req, { action: "lost_reason.updated", entityType: "lost_reason", entityId: id, diff: patch });
  return { lostReason: reasonView(row) };
}

export async function archiveLostReason(req: FastifyRequest, id: string) {
  const [row] = await req.db
    .update(schema.lostReasons)
    .set({ archivedAt: new Date() })
    .where(and(eq(schema.lostReasons.id, id), isNull(schema.lostReasons.archivedAt)))
    .returning({ id: schema.lostReasons.id });
  if (!row) throw notFound("LOST_REASON_NOT_FOUND", "Lost reason not found");
  await audit(req, { action: "lost_reason.archived", entityType: "lost_reason", entityId: id });
}

// ── Tags ───────────────────────────────────────────────────────────────────────
const tagView = (t: typeof schema.tags.$inferSelect) => ({ id: t.id, label: t.label, color: t.color });

export async function listTags(req: FastifyRequest) {
  return { tags: (await req.db.select().from(schema.tags).orderBy(asc(schema.tags.label))).map(tagView) };
}

async function assertTagLabelFree(req: FastifyRequest, label: string, exceptId?: string) {
  const where = exceptId ? and(eq(schema.tags.label, label), ne(schema.tags.id, exceptId)) : eq(schema.tags.label, label);
  const [dup] = await req.db.select({ id: schema.tags.id }).from(schema.tags).where(where);
  if (dup) throw conflict("TAG_EXISTS", "That tag already exists");
}

export async function createTag(req: FastifyRequest, input: { label: string; color?: string }) {
  await assertTagLabelFree(req, input.label);
  const id = newId();
  const [row] = await req.db.insert(schema.tags).values({ id, ...input }).returning();
  await audit(req, { action: "tag.created", entityType: "tag", entityId: id, diff: input });
  return { tag: tagView(row!) };
}

export async function updateTag(req: FastifyRequest, id: string, patch: { label?: string; color?: string }) {
  if (patch.label) await assertTagLabelFree(req, patch.label, id);
  const [row] = await req.db.update(schema.tags).set(patch).where(eq(schema.tags.id, id)).returning();
  if (!row) throw notFound("TAG_NOT_FOUND", "Tag not found");
  await audit(req, { action: "tag.updated", entityType: "tag", entityId: id, diff: patch });
  return { tag: tagView(row) };
}

export async function deleteTag(req: FastifyRequest, id: string) {
  const [row] = await req.db.delete(schema.tags).where(eq(schema.tags.id, id)).returning({ id: schema.tags.id });
  if (!row) throw notFound("TAG_NOT_FOUND", "Tag not found");
  await audit(req, { action: "tag.deleted", entityType: "tag", entityId: id });
}

// ── Products ───────────────────────────────────────────────────────────────────
const productView = (p: typeof schema.products.$inferSelect) => ({ id: p.id, name: p.name, defaultValue: p.defaultValue, currency: p.currency });
export type ProductInput = { name?: string; defaultValue?: number | null; currency?: string | null };

export async function listProducts(req: FastifyRequest) {
  const rows = await req.db.select().from(schema.products).where(isNull(schema.products.archivedAt)).orderBy(asc(schema.products.name));
  return { products: rows.map(productView) };
}

async function assertProductNameFree(req: FastifyRequest, name: string, exceptId?: string) {
  const [dup] = await req.db.select({ id: schema.products.id }).from(schema.products).where(and(eq(schema.products.name, name), isNull(schema.products.archivedAt)));
  if (dup && dup.id !== exceptId) throw conflict("PRODUCT_EXISTS", "A product with that name already exists");
}

export async function createProduct(req: FastifyRequest, input: ProductInput & { name: string }) {
  await assertProductNameFree(req, input.name);
  const id = newId();
  const [row] = await req.db.insert(schema.products).values({ id, ...input }).returning();
  await audit(req, { action: "product.created", entityType: "product", entityId: id, diff: { name: input.name } });
  return { product: productView(row!) };
}

export async function updateProduct(req: FastifyRequest, id: string, patch: ProductInput) {
  if (patch.name) await assertProductNameFree(req, patch.name, id);
  const [row] = await req.db
    .update(schema.products)
    .set(patch)
    .where(and(eq(schema.products.id, id), isNull(schema.products.archivedAt)))
    .returning();
  if (!row) throw notFound("PRODUCT_NOT_FOUND", "Product not found");
  await audit(req, { action: "product.updated", entityType: "product", entityId: id, diff: { fields: Object.keys(patch) } });
  return { product: productView(row) };
}

export async function archiveProduct(req: FastifyRequest, id: string) {
  const [row] = await req.db
    .update(schema.products)
    .set({ archivedAt: new Date() })
    .where(and(eq(schema.products.id, id), isNull(schema.products.archivedAt)))
    .returning({ id: schema.products.id });
  if (!row) throw notFound("PRODUCT_NOT_FOUND", "Product not found");
  await audit(req, { action: "product.archived", entityType: "product", entityId: id });
}
```

`apps/api/src/modules/catalog/routes.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as svc from "./service";

const read = { permission: "leads.view" as const };
const pipelines = { permission: "pipelines.manage" as const };
const settings = { permission: "settings.manage" as const };
const params = z.object({ id: z.uuid() });
const label = z.string().trim().min(1).max(60);
const COLORS = ["accent", "ok", "warn", "danger", "meet", "cyan", "neutral"] as const;
const product = z.object({
  name: z.string().trim().min(1).max(80),
  defaultValue: z.number().nonnegative().max(1e12).nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
});

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/api/v1/lost-reasons", { config: read }, (req) => svc.listLostReasons(req));
  r.post("/api/v1/lost-reasons", { config: pipelines, schema: { body: z.object({ label }) } }, async (req, reply) =>
    reply.code(201).send(await svc.createLostReason(req, req.body.label)),
  );
  r.patch(
    "/api/v1/lost-reasons/:id",
    { config: pipelines, schema: { params, body: z.object({ label: label.optional(), position: z.number().int().min(0).max(1000).optional() }).strict() } },
    (req) => svc.updateLostReason(req, req.params.id, req.body),
  );
  r.post("/api/v1/lost-reasons/:id/archive", { config: pipelines, schema: { params } }, async (req, reply) => {
    await svc.archiveLostReason(req, req.params.id);
    return reply.code(204).send();
  });

  r.get("/api/v1/tags", { config: read }, (req) => svc.listTags(req));
  r.post("/api/v1/tags", { config: settings, schema: { body: z.object({ label, color: z.enum(COLORS).optional() }) } }, async (req, reply) =>
    reply.code(201).send(await svc.createTag(req, req.body)),
  );
  r.patch("/api/v1/tags/:id", { config: settings, schema: { params, body: z.object({ label: label.optional(), color: z.enum(COLORS).optional() }).strict() } }, (req) =>
    svc.updateTag(req, req.params.id, req.body),
  );
  r.delete("/api/v1/tags/:id", { config: settings, schema: { params } }, async (req, reply) => {
    await svc.deleteTag(req, req.params.id);
    return reply.code(204).send();
  });

  r.get("/api/v1/products", { config: read }, (req) => svc.listProducts(req));
  r.post("/api/v1/products", { config: settings, schema: { body: product } }, async (req, reply) => reply.code(201).send(await svc.createProduct(req, req.body)));
  r.patch("/api/v1/products/:id", { config: settings, schema: { params, body: product.partial().strict() } }, (req) => svc.updateProduct(req, req.params.id, req.body));
  r.post("/api/v1/products/:id/archive", { config: settings, schema: { params } }, async (req, reply) => {
    await svc.archiveProduct(req, req.params.id);
    return reply.code(204).send();
  });
}
```

`apps/api/src/modules/roles/field-access.ts`:
```ts
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { FIELD_ACCESS_RANK, fieldAccessOf, type FieldAccess } from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, notFound } from "../../http/errors";
import { notifyRbac } from "../../rbac/notify";

/** Replace a role's field-access rows. `edit` is the default, so only hidden/view rows are stored. */
export async function setFieldAccess(req: FastifyRequest, roleId: string, entries: { fieldId: string; access: FieldAccess }[]) {
  const [role] = await req.db.select({ id: schema.roles.id }).from(schema.roles).where(and(eq(schema.roles.id, roleId), isNull(schema.roles.deletedAt)));
  if (!role) throw notFound("ROLE_NOT_FOUND", "Role not found");
  const ids = entries.map((e) => e.fieldId);
  if (new Set(ids).size !== ids.length) throw badRequest("DUPLICATE_FIELD", "A field is listed twice");
  if (ids.length) {
    const found = await req.db.select({ id: schema.fieldDefinitions.id }).from(schema.fieldDefinitions).where(inArray(schema.fieldDefinitions.id, ids));
    if (found.length !== ids.length) throw badRequest("UNKNOWN_FIELD", "One of those fields doesn't exist");
  }
  // Escalation guard (as in 1A): the resulting access for every field may not exceed the actor's own.
  const actor = req.actor!;
  if (!actor.isOwner) {
    const allFields = await req.db.select({ id: schema.fieldDefinitions.id }).from(schema.fieldDefinitions);
    const given = new Map(entries.map((e) => [e.fieldId, e.access]));
    const beyond = allFields
      .map((f) => ({ id: f.id, access: given.get(f.id) ?? ("edit" as FieldAccess) }))
      .filter((f) => FIELD_ACCESS_RANK[f.access] > FIELD_ACCESS_RANK[fieldAccessOf(actor.fieldAccess, f.id)]);
    if (beyond.length) {
      throw new HttpError(403, "ESCALATION", "You can only give field access you have yourself", { fields: beyond.map((f) => f.id) });
    }
  }
  await req.db.delete(schema.roleFieldAccess).where(eq(schema.roleFieldAccess.roleId, roleId));
  const stored = entries.filter((e) => e.access !== "edit");
  if (stored.length) await req.db.insert(schema.roleFieldAccess).values(stored.map((e) => ({ roleId, ...e })));
  await notifyRbac(req);
  await audit(req, { action: "role.field_access.updated", entityType: "role", entityId: roleId, diff: { entries: stored } });
  return { entries: stored };
}
```
In `apps/api/src/modules/roles/routes.ts`, add:
```ts
  r.put(
    "/api/v1/roles/:id/field-access",
    {
      config: cfg,
      schema: { params, body: z.object({ entries: z.array(z.object({ fieldId: z.uuid(), access: z.enum(["hidden", "view", "edit"]) })).max(500) }) },
    },
    (req) => setFieldAccess(req, req.params.id, req.body.entries),
  );
```
Also make `GET /roles/:id` include `fieldAccess: { fieldId, access }[]` in the role view. (In `roles/service.ts` `getRole`, select from `schema.roleFieldAccess` where `roleId = id`.)

Register `fieldRoutes` and `catalogRoutes` in `app.ts`.

- [ ] **Step 4: Run to verify**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/api && pnpm lint && pnpm typecheck'`
Expected: fields (4) and catalog (4) pass. The matrix test fails "every route has a probe" for the new routes; that's expected until Task 9. **Add the new probes now** (Task 9 Step 2 lists them, with `access` values) so the gate stays green, and move on.

- [ ] **Step 5: Commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(api): field definitions with stable option ids, lost reasons, tags, products, per-role field access (no escalation)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 6: Leads — create, read, list, edit, delete (serializer + duplicates)

**Files:**
- Create: `apps/api/src/modules/leads/{serialize,duplicates,query,service,routes}.ts`, `apps/api/src/modules/leads/leads.test.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/modules/pipelines/pipelines.test.ts` (un-skip)

**Interfaces:**
- Produces:
  - `serializeLead(row, ctx: { actor: ActorRecord; fields: FieldRegistry; tagIds: string[] }): LeadView`
  - `LeadView = { id, version, pipelineId, stageId?, ownerId?, name?, phone?: ContactView | null, email?: ContactView | null, instagram?: ContactView | null, sourceId?, value?, currency?, productId, lostReasonId, lostNote, wonAt, lostAt, leadCreatedAt?, lastActivityAt, stageEnteredAt, createdAt, updatedAt, tagIds, custom, contactMasked }`, where `ContactView = { display: string; masked: boolean; status?: PhoneStatus }`. Fields the caller can't see are absent.
  - `findDuplicates(req, c: { phoneE164?: string | null; email?: string | null; instagram?: string | null }, excludeLeadId?): Promise<Duplicate[]>`, where `Duplicate = { visible: true; leadId; name; ownerName: string | null; matchedOn: Kind[] } | { visible: false; matchedOn: Kind[] }`
  - `visibleLead(req, id): Promise<LeadRow>` (404 `LEAD_NOT_FOUND`), `leadViewFor(req, row): Promise<LeadView>`
  - Routes:
    - `POST /leads` (leads.create) → 201 `{ lead, duplicates }`
    - `GET /leads/:id` (leads.view) → `{ lead }`
    - `GET /leads` (leads.view) `?cursor&limit&sort&pipelineId&stageId&ownerId&tagId&phoneStatus&q&createdFrom&createdTo&custom` → `{ items, nextCursor }`
    - `PATCH /leads/:id` (leads.edit) with `If-Match` → `{ lead }`
    - `DELETE /leads/:id` (leads.delete) → 204
    - `GET /leads/duplicates` (leads.create) `?phone&email&instagram` → `{ duplicates }`

- [ ] **Step 1: Write the failing tests**

`apps/api/src/modules/leads/leads.test.ts`:
```ts
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";

let h: Harness;
let admin: AuthedClient;
let repUser: SeededUser;
let rep: AuthedClient;
const SALES = [
  { key: "leads.view", scope: "own" },
  { key: "leads.edit", scope: "own" },
  { key: "leads.change_stage", scope: "own" },
  { key: "leads.contact.reveal", scope: "own" },
  { key: "leads.create", scope: null },
] as const;

beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
  repUser = await h.seedUser({ grants: [...SALES] });
  rep = await h.signIn(repUser);
});
afterAll(async () => h.close());

const create = (c: AuthedClient, body: object) => c.inject({ method: "POST", url: "/api/v1/leads", payload: body });

describe("creating leads (report §8.3)", () => {
  it("normalises the phone, defaults the pipeline/stage, and a rep's lead is theirs", async () => {
    const r = await create(rep, { name: "Asha", phone: "050 123 4567", email: "Asha@Example.com" });
    expect(r.statusCode).toBe(201);
    const { lead } = r.json();
    const cfg = await h.config();
    expect(lead).toMatchObject({ name: "Asha", pipelineId: cfg.pipelineId, stageId: cfg.stages.New, ownerId: repUser.id, version: 1 });
    // A Sales rep sees their own lead's contacts masked (reveal, not full).
    expect(lead.phone).toEqual({ display: "+971 50 ••• ••67", masked: true, status: "valid" });
    expect(lead.email.display).toBe("a•••@example.com");
    expect(lead.contactMasked).toBe(true);
    const full = (await admin.inject({ method: "GET", url: `/api/v1/leads/${lead.id}` })).json().lead;
    expect(full.phone).toEqual({ display: "+971 50 123 4567", masked: false, status: "valid" });
    expect(full.email.display).toBe("asha@example.com");
  });

  it("validates custom fields against the live definitions", async () => {
    const cfg = await h.config();
    const bad = await create(admin, { name: "X", custom: { struggles: ["not-an-option"] } });
    expect(bad.statusCode).toBe(400);
    const opt = (await h.ownerPool.query("SELECT options->0->>'id' AS id FROM field_definitions WHERE id = $1", [cfg.fields.struggles])).rows[0].id;
    const ok = await create(admin, { name: "Y", custom: { struggles: [opt], handled_by: repUser.id } });
    expect(ok.json().lead.custom).toEqual({ struggles: [opt], handled_by: repUser.id });
    const ghost = await create(admin, { name: "Z", custom: { handled_by: "0190e0c0-0000-7000-8000-00000000dead" } });
    expect(ghost.json().error.code).toBe("UNKNOWN_USER");
  });

  it("a rep can't create a lead for someone else; an admin can", async () => {
    const other = await h.seedUser({ grants: [] });
    expect((await create(rep, { name: "Nope", ownerId: other.id })).statusCode).toBe(403);
    expect((await create(admin, { name: "Handed", ownerId: other.id })).json().lead.ownerId).toBe(other.id);
  });

  it("warns about duplicates, naming the owner only when the caller can see the lead", async () => {
    const other = await h.seedUser({ grants: [], name: "Priya" });
    await h.seedLead({ ownerId: other.id, phone: "+971509998877" });
    const r = await create(rep, { name: "Dup", phone: "+971 50 999 8877" });
    expect(r.statusCode).toBe(201);
    expect(r.json().duplicates).toEqual([{ visible: false, matchedOn: ["phone"] }]);
    const a = (await admin.inject({ method: "GET", url: "/api/v1/leads/duplicates?phone=%2B971509998877" })).json().duplicates;
    // The admin sees every match (Priya's lead and the rep's new one), with owners named.
    expect(a).toContainEqual(expect.objectContaining({ visible: true, ownerName: "Priya", matchedOn: ["phone"] }));
    expect(a.every((d: { visible: boolean }) => d.visible)).toBe(true);
  });
});

describe("reading leads (report §4.4, §7.4)", () => {
  it("an out-of-scope lead is a 404, exactly like a missing one", async () => {
    const other = await h.seedUser({ grants: [] });
    const theirs = await h.seedLead({ ownerId: other.id });
    const a = await rep.inject({ method: "GET", url: `/api/v1/leads/${theirs}` });
    const b = await rep.inject({ method: "GET", url: "/api/v1/leads/0190e0c0-0000-7000-8000-00000000beef" });
    expect(a.statusCode).toBe(404);
    expect(a.json()).toEqual(b.json());
  });

  it("hidden fields vanish from responses; view-only fields can't be written", async () => {
    const cfg = await h.config();
    const u = await h.seedUser({ grants: [...SALES] });
    const { rows: [role] } = await h.pool.query("SELECT role_id FROM user_roles WHERE user_id = $1", [u.id]);
    await admin.inject({ method: "PUT", url: `/api/v1/roles/${role.role_id}/field-access`, payload: { entries: [{ fieldId: cfg.fields.phone, access: "hidden" }, { fieldId: cfg.fields.email, access: "view" }] } });
    await h.waitForRbacNotify();
    const c = await h.signIn(u);
    const lead = (await create(c, { name: "Hidden phone" })).json().lead;
    expect("phone" in lead).toBe(false);
    expect("email" in lead).toBe(true);
    const w = await c.inject({ method: "PATCH", url: `/api/v1/leads/${lead.id}`, headers: { "if-match": String(lead.version) }, payload: { email: "x@y.com" } });
    expect(w.json().error.code).toBe("FIELD_NOT_EDITABLE");
    expect((await create(c, { name: "Sneaky", phone: "+971501112233" })).json().error.code).toBe("FIELD_NOT_EDITABLE");
  });
});

describe("listing and search (report §14, §12.2)", () => {
  it("returns only in-scope leads, pages with a cursor, and never more than 100", async () => {
    const u = await h.seedUser({ grants: [...SALES] });
    const c = await h.signIn(u);
    for (let i = 0; i < 5; i++) await h.seedLead({ ownerId: u.id, name: `Paged ${i}` });
    const p1 = (await c.inject({ method: "GET", url: "/api/v1/leads?limit=3" })).json();
    expect(p1.items).toHaveLength(3);
    const p2 = (await c.inject({ method: "GET", url: `/api/v1/leads?limit=3&cursor=${p1.nextCursor}` })).json();
    expect(p2.items).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();
    expect([...p1.items, ...p2.items].every((l: { ownerId: string }) => l.ownerId === u.id)).toBe(true);
    expect((await c.inject({ method: "GET", url: "/api/v1/leads?limit=101" })).statusCode).toBe(400);
  });

  it("filters by stage and owner, and searches names", async () => {
    const cfg = await h.config();
    const u = await h.seedUser({ grants: [] });
    await h.seedLead({ ownerId: u.id, name: "Zoya Findme", stage: "Call booked" });
    const byStage = (await admin.inject({ method: "GET", url: `/api/v1/leads?stageId=${cfg.stages["Call booked"]}&ownerId=${u.id}` })).json().items;
    expect(byStage.map((l: { name: string }) => l.name)).toEqual(["Zoya Findme"]);
    const found = (await admin.inject({ method: "GET", url: "/api/v1/leads?q=findme" })).json().items;
    expect(found.map((l: { name: string }) => l.name)).toContain("Zoya Findme");
  });

  it("masked roles cannot search by phone or email (no enumeration)", async () => {
    await create(rep, { name: "Contact Search", phone: "+971501239999", email: "hunt@example.com" });
    expect((await rep.inject({ method: "GET", url: "/api/v1/leads?q=1239999" })).json().items).toHaveLength(0);
    expect((await rep.inject({ method: "GET", url: "/api/v1/leads?q=hunt%40example" })).json().items).toHaveLength(0);
    expect((await admin.inject({ method: "GET", url: "/api/v1/leads?q=1239999" })).json().items.map((l: { name: string }) => l.name)).toContain("Contact Search");
  });
});

describe("editing (optimistic concurrency, report §4.4)", () => {
  it("requires If-Match, refuses stale versions, and bumps the version", async () => {
    const lead = (await create(rep, { name: "Versioned" })).json().lead;
    const url = `/api/v1/leads/${lead.id}`;
    expect((await rep.inject({ method: "PATCH", url, payload: { name: "No header" } })).statusCode).toBe(428);
    const ok = await rep.inject({ method: "PATCH", url, headers: { "if-match": "1" }, payload: { name: "V2", phone: "+971 50 000 1111" } });
    expect(ok.json().lead).toMatchObject({ name: "V2", version: 2 });
    const stale = await rep.inject({ method: "PATCH", url, headers: { "if-match": "1" }, payload: { name: "Stale" } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ code: "VERSION_CONFLICT", details: { currentVersion: 2 } });
  });

  it("records a field_changed activity without contact values", async () => {
    const lead = (await create(rep, { name: "Audited" })).json().lead;
    await rep.inject({ method: "PATCH", url: `/api/v1/leads/${lead.id}`, headers: { "if-match": "1" }, payload: { phone: "+971501234000" } });
    const acts = (await admin.inject({ method: "GET", url: `/api/v1/leads/${lead.id}/activities` })).json().items;
    const changed = acts.find((a: { type: string }) => a.type === "field_changed");
    expect(changed.payload).toEqual({ fields: ["phone"] });
    expect(JSON.stringify(acts)).not.toContain("1234000");
  });

  it("soft-deletes with permission; the lead then 404s", async () => {
    const lead = (await create(admin, { name: "Bin me" })).json().lead;
    expect((await rep.inject({ method: "DELETE", url: `/api/v1/leads/${lead.id}` })).statusCode).toBe(403);
    expect((await admin.inject({ method: "DELETE", url: `/api/v1/leads/${lead.id}` })).statusCode).toBe(204);
    expect((await admin.inject({ method: "GET", url: `/api/v1/leads/${lead.id}` })).statusCode).toBe(404);
  });
});
```
The activities assertion needs `GET /leads/:id/activities` from Task 7. Keep it; this file is re-run after Task 7. For this task's gate, mark that one test `it.skip` with `// un-skipped in Task 7`.

- [ ] **Step 2: Run to verify they fail**

Run: `scripts/dev.sh run pnpm vitest run apps/api/src/modules/leads`
Expected: FAIL (404 on /leads).

- [ ] **Step 3: Implement**

`apps/api/src/modules/leads/serialize.ts`:
```ts
import { canOnRecord, fieldAccessOf, formatPhone, maskEmail, maskInstagram, maskPhone, type PhoneStatus } from "@lume/core";
import type { schema } from "@lume/db";
import type { FieldRegistry } from "../../leads/fields";
import type { ActorRecord } from "../../rbac/actor";

export type LeadRow = typeof schema.leads.$inferSelect;
export type ContactView = { display: string; masked: boolean; status?: PhoneStatus };
export type LeadView = Record<string, unknown> & { id: string; version: number; pipelineId: string; contactMasked: boolean; tagIds: string[]; custom: Record<string, unknown> };
export type SerializeCtx = { actor: ActorRecord; fields: FieldRegistry; tagIds: string[] };

/** Core field key → property it controls in the response (report §6 core fields). */
const CORE_PROPS: Record<string, string[]> = {
  name: ["name"],
  phone: ["phone"],
  email: ["email"],
  instagram: ["instagram"],
  owner: ["ownerId"],
  stage: ["stageId"],
  source: ["sourceId"],
  value: ["value", "currency"],
  lead_created_at: ["leadCreatedAt"],
};

export function isFieldVisible(ctx: Pick<SerializeCtx, "actor" | "fields">, key: string): boolean {
  const def = ctx.fields.byKey.get(key);
  return !def || fieldAccessOf(ctx.actor.fieldAccess, def.id) !== "hidden";
}

export function isFieldEditable(ctx: Pick<SerializeCtx, "actor" | "fields">, key: string): boolean {
  const def = ctx.fields.byKey.get(key);
  return !!def && !def.archived && fieldAccessOf(ctx.actor.fieldAccess, def.id) === "edit";
}

/**
 * The only way a lead leaves the API (report §7.4 layer 2). Contact values are masked unless the caller
 * has leads.contact.full on this lead; fields hidden from the caller are removed, not blanked.
 */
export function serializeLead(row: LeadRow, ctx: SerializeCtx): LeadView {
  const full = canOnRecord(ctx.actor, "leads.contact.full", row.ownerId);
  const phone: ContactView | null =
    row.phoneStatus === "missing"
      ? null
      : full
        ? { display: row.phoneE164 ? formatPhone(row.phoneE164) : (row.phoneRaw ?? ""), masked: false, status: row.phoneStatus }
        : { display: maskPhone({ e164: row.phoneE164, raw: row.phoneRaw }), masked: true, status: row.phoneStatus };
  const email: ContactView | null = row.email ? { display: full ? row.email.toLowerCase() : maskEmail(row.email.toLowerCase()), masked: !full } : null;
  const instagram: ContactView | null = row.instagramHandle
    ? { display: full ? `@${row.instagramHandle}` : maskInstagram(row.instagramHandle), masked: !full }
    : null;

  const custom: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row.custom ?? {})) {
    const def = ctx.fields.byKey.get(key);
    if (def && !def.archived && !def.isCore && isFieldVisible(ctx, key)) custom[key] = value;
  }

  const view: LeadView = {
    id: row.id,
    version: row.version,
    pipelineId: row.pipelineId,
    stageId: row.stageId,
    ownerId: row.ownerId,
    name: row.name,
    phone,
    email,
    instagram,
    sourceId: row.sourceId,
    value: row.value,
    currency: row.currency,
    productId: row.productId,
    lostReasonId: row.lostReasonId,
    lostNote: row.lostNote,
    wonAt: row.wonAt,
    lostAt: row.lostAt,
    leadCreatedAt: row.leadCreatedAt,
    lastActivityAt: row.lastActivityAt,
    stageEnteredAt: row.stageEnteredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    tagIds: ctx.tagIds,
    custom,
    contactMasked: !full,
  };
  for (const [key, props] of Object.entries(CORE_PROPS)) {
    if (!isFieldVisible(ctx, key)) for (const p of props) delete view[p];
  }
  return view;
}
```

`apps/api/src/modules/leads/duplicates.ts`:
```ts
import { and, inArray, isNull, or, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { contactKeyHash, schema } from "@lume/db";

type Kind = "phone" | "email" | "instagram";
export type Duplicate = { visible: true; leadId: string; name: string; ownerName: string | null; matchedOn: Kind[] } | { visible: false; matchedOn: Kind[] };

/**
 * Report §8.3: warn about existing leads with the same phone/email/Instagram across *all* leads, but only
 * describe the ones the caller may see. Matching uses hashes (lead_contact_keys), never plaintext.
 */
export async function findDuplicates(
  req: FastifyRequest,
  c: { phoneE164?: string | null; email?: string | null; instagram?: string | null },
  excludeLeadId?: string,
): Promise<Duplicate[]> {
  const probes: { kind: Kind; hash: string }[] = [];
  if (c.phoneE164) probes.push({ kind: "phone", hash: contactKeyHash("phone", c.phoneE164) });
  if (c.email) probes.push({ kind: "email", hash: contactKeyHash("email", c.email.toLowerCase()) });
  if (c.instagram) probes.push({ kind: "instagram", hash: contactKeyHash("instagram", c.instagram.toLowerCase()) });
  if (!probes.length) return [];
  const hits = await req.db
    .select()
    .from(schema.leadContactKeys)
    .where(or(...probes.map((p) => and(eq(schema.leadContactKeys.kind, p.kind), eq(schema.leadContactKeys.keyHash, p.hash)))));
  const byLead = new Map<string, Kind[]>();
  for (const h of hits) if (h.leadId !== excludeLeadId) byLead.set(h.leadId, [...(byLead.get(h.leadId) ?? []), h.kind]);
  if (!byLead.size) return [];
  // RLS decides which of these the caller may learn about.
  const visible = await req.db
    .select({ id: schema.leads.id, name: schema.leads.name, ownerName: schema.users.name })
    .from(schema.leads)
    .leftJoin(schema.users, eq(schema.users.id, schema.leads.ownerId))
    .where(and(inArray(schema.leads.id, [...byLead.keys()]), isNull(schema.leads.deletedAt)));
  const seen = new Map(visible.map((v) => [v.id, v]));
  return [...byLead].map(([leadId, matchedOn]) => {
    const v = seen.get(leadId);
    return v ? { visible: true as const, leadId, name: v.name, ownerName: v.ownerName, matchedOn } : { visible: false as const, matchedOn };
  });
}
```

`apps/api/src/modules/leads/query.ts`:
```ts
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { SCOPE_RANK, scopeOf } from "@lume/core";
import { schema } from "@lume/db";
import { badRequest } from "../../http/errors";
import { loadFieldRegistry } from "../../leads/fields";
import { isFieldVisible, serializeLead, type LeadRow } from "./serialize";

export type ListQuery = {
  cursor?: string;
  limit: number;
  sort: "newest" | "oldest" | "updated" | "name";
  pipelineId?: string;
  stageId?: string; // comma-separated
  ownerId?: string; // uuid | "me" | "none"
  tagId?: string;
  phoneStatus?: "valid" | "needs_country" | "invalid" | "missing";
  q?: string;
  createdFrom?: string;
  createdTo?: string;
  custom?: string; // JSON object: { fieldKey: value }
};

const L = schema.leads;
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Masked roles search names only (report §12.2 #4: no search by contact for masked roles). */
function canSearchContacts(req: FastifyRequest): boolean {
  const a = req.actor!;
  if (a.isOwner) return true;
  const full = scopeOf(a, "leads.contact.full");
  const view = scopeOf(a, "leads.view");
  return full !== null && view !== null && SCOPE_RANK[full] >= SCOPE_RANK[view];
}

function encodeCursor(sort: ListQuery["sort"], row: LeadRow): string {
  const v = sort === "updated" ? row.updatedAt.toISOString() : sort === "name" ? row.name.toLowerCase() : null;
  return Buffer.from(JSON.stringify([sort, v, row.id])).toString("base64url");
}

function cursorWhere(sort: ListQuery["sort"], cursor: string | undefined): SQL | undefined {
  if (!cursor) return undefined;
  let parsed: [string, string | null, string];
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw badRequest("BAD_CURSOR", "That cursor isn't valid");
  }
  const [s, v, id] = parsed;
  if (s !== sort || typeof id !== "string") throw badRequest("BAD_CURSOR", "That cursor isn't valid");
  switch (sort) {
    case "newest":
      return lt(L.id, id);
    case "oldest":
      return gt(L.id, id);
    case "updated":
      return sql`(${L.updatedAt}, ${L.id}) < (${v}::timestamptz, ${id}::uuid)`;
    case "name":
      return sql`(lower(${L.name}), ${L.id}) > (${v}, ${id}::uuid)`;
  }
}

const orderBy = (sort: ListQuery["sort"]) =>
  sort === "newest" ? [desc(L.id)] : sort === "oldest" ? [asc(L.id)] : sort === "updated" ? [desc(L.updatedAt), desc(L.id)] : [sql`lower(${L.name}) asc`, asc(L.id)];

export async function listLeads(req: FastifyRequest, q: ListQuery) {
  const fields = await loadFieldRegistry(req);
  const ctx = { actor: req.actor!, fields };
  const where: (SQL | undefined)[] = [isNull(L.deletedAt), cursorWhere(q.sort, q.cursor)];

  if (q.pipelineId) where.push(eq(L.pipelineId, q.pipelineId));
  if (q.stageId) where.push(inArray(L.stageId, q.stageId.split(",")));
  if (q.ownerId === "me") where.push(eq(L.ownerId, req.actor!.userId));
  else if (q.ownerId === "none") where.push(isNull(L.ownerId));
  else if (q.ownerId) where.push(eq(L.ownerId, q.ownerId));
  if (q.tagId) where.push(sql`EXISTS (SELECT 1 FROM lead_tags t WHERE t.lead_id = ${L.id} AND t.tag_id = ${q.tagId})`);
  if (q.phoneStatus) {
    if (!isFieldVisible(ctx, "phone")) throw badRequest("UNKNOWN_FIELD", "Unknown filter");
    where.push(eq(L.phoneStatus, q.phoneStatus));
  }
  if (q.createdFrom) where.push(sql`${L.leadCreatedAt} >= ${q.createdFrom}::date`);
  if (q.createdTo) where.push(sql`${L.leadCreatedAt} <= ${q.createdTo}::date`);

  if (q.q) {
    const term = `%${likeEscape(q.q.trim())}%`;
    const terms: SQL[] = [sql`${L.name} ILIKE ${term}`];
    if (canSearchContacts(req)) {
      if (isFieldVisible(ctx, "email")) terms.push(sql`${L.email}::text ILIKE ${term}`);
      if (isFieldVisible(ctx, "instagram")) terms.push(sql`${L.instagramHandle}::text ILIKE ${term}`);
      const digits = q.q.replace(/\D/g, "");
      if (digits.length >= 4 && isFieldVisible(ctx, "phone")) terms.push(sql`${L.phoneDigits} LIKE ${`%${digits}%`}`);
    }
    where.push(or(...terms));
  }

  if (q.custom) {
    let filter: Record<string, unknown>;
    try {
      filter = JSON.parse(q.custom);
    } catch {
      throw badRequest("BAD_FILTER", "custom must be a JSON object");
    }
    if (typeof filter !== "object" || filter === null || Array.isArray(filter)) throw badRequest("BAD_FILTER", "custom must be a JSON object");
    for (const [key, value] of Object.entries(filter)) {
      const def = fields.byKey.get(key);
      if (!def || def.isCore || def.archived || !isFieldVisible(ctx, key)) throw badRequest("UNKNOWN_FIELD", "Unknown filter");
      if (!["select", "multi_select", "boolean", "user"].includes(def.type)) throw badRequest("BAD_FILTER", `${key} can't be filtered yet`);
      const probe = def.type === "multi_select" ? { [key]: [value] } : { [key]: value };
      where.push(sql`${L.custom} @> ${JSON.stringify(probe)}::jsonb`);
    }
  }

  const rows = await req.db.select().from(L).where(and(...where)).orderBy(...orderBy(q.sort)).limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const tags = page.length
    ? await req.db.select().from(schema.leadTags).where(inArray(schema.leadTags.leadId, page.map((r) => r.id)))
    : [];
  return {
    items: page.map((r) => serializeLead(r, { ...ctx, tagIds: tags.filter((t) => t.leadId === r.id).map((t) => t.tagId) })),
    nextCursor: rows.length > q.limit ? encodeCursor(q.sort, page.at(-1)!) : null,
  };
}
```

`apps/api/src/modules/leads/service.ts`:
```ts
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { canOnRecord, normalizeInstagram, normalizePhone, newId, scopeOf, type NormalizedPhone } from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, forbidden, notFound } from "../../http/errors";
import { loadFieldRegistry, type FieldRegistry } from "../../leads/fields";
import { findDuplicates } from "./duplicates";
import { isFieldEditable, serializeLead, type LeadRow } from "./serialize";

const L = schema.leads;

export type LeadInput = {
  name?: string;
  phone?: string | null;
  email?: string | null;
  instagram?: string | null;
  pipelineId?: string;
  stageId?: string;
  ownerId?: string | null;
  value?: number | null;
  currency?: string | null;
  productId?: string | null;
  leadCreatedAt?: string | null;
  tagIds?: string[];
  custom?: Record<string, unknown>;
};

/** Core input property → the field key whose access governs writing it. */
const CORE_KEY: Record<string, string> = {
  name: "name",
  phone: "phone",
  email: "email",
  instagram: "instagram",
  ownerId: "owner",
  value: "value",
  currency: "value",
  leadCreatedAt: "lead_created_at",
};

export async function visibleLead(req: FastifyRequest, id: string): Promise<LeadRow> {
  const [row] = await req.db.select().from(L).where(and(eq(L.id, id), isNull(L.deletedAt)));
  if (!row) throw notFound("LEAD_NOT_FOUND", "Lead not found"); // out of scope looks exactly like missing
  return row;
}

export async function tagIdsOf(req: FastifyRequest, leadId: string): Promise<string[]> {
  return (await req.db.select({ id: schema.leadTags.tagId }).from(schema.leadTags).where(eq(schema.leadTags.leadId, leadId))).map((t) => t.id);
}

export async function leadViewFor(req: FastifyRequest, row: LeadRow, fields?: FieldRegistry) {
  return serializeLead(row, { actor: req.actor!, fields: fields ?? (await loadFieldRegistry(req)), tagIds: await tagIdsOf(req, row.id) });
}

export async function recordActivity(req: FastifyRequest, leadId: string, type: string, payload: Record<string, unknown> = {}) {
  await req.db.insert(schema.activities).values({ id: newId(), leadId, userId: req.actor!.userId, type, payload });
}

function assertWritable(req: FastifyRequest, fields: FieldRegistry, input: LeadInput) {
  const ctx = { actor: req.actor!, fields };
  const blocked = new Set<string>();
  for (const [prop, key] of Object.entries(CORE_KEY)) if (prop in input && !isFieldEditable(ctx, key)) blocked.add(key);
  for (const key of Object.keys(input.custom ?? {})) if (!isFieldEditable(ctx, key)) blocked.add(key);
  if (blocked.size) throw new HttpError(403, "FIELD_NOT_EDITABLE", "Some of these fields can't be changed by you", { fields: [...blocked] });
}

function validateCustom(fields: FieldRegistry, custom: Record<string, unknown> | undefined, mode: "create" | "patch") {
  const parsed = fields.custom[mode].safeParse(custom ?? {});
  if (!parsed.success) throw badRequest("INVALID_CUSTOM_FIELDS", "Some fields are invalid", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return parsed.data;
}

async function assertUsersExist(req: FastifyRequest, fields: FieldRegistry, custom: Record<string, unknown>) {
  const ids = Object.entries(custom)
    .filter(([k, v]) => fields.byKey.get(k)?.type === "user" && typeof v === "string")
    .map(([, v]) => v as string);
  if (!ids.length) return;
  const found = await req.db.select({ id: schema.users.id }).from(schema.users).where(and(inArray(schema.users.id, ids), eq(schema.users.status, "active")));
  if (found.length !== new Set(ids).size) throw badRequest("UNKNOWN_USER", "One of those people doesn't exist or is disabled");
}

async function assertRefs(req: FastifyRequest, input: LeadInput) {
  if (input.productId) {
    const [p] = await req.db.select({ id: schema.products.id }).from(schema.products).where(and(eq(schema.products.id, input.productId), isNull(schema.products.archivedAt)));
    if (!p) throw badRequest("UNKNOWN_PRODUCT", "That product doesn't exist");
  }
  if (input.tagIds?.length) {
    const found = await req.db.select({ id: schema.tags.id }).from(schema.tags).where(inArray(schema.tags.id, input.tagIds));
    if (found.length !== new Set(input.tagIds).size) throw badRequest("UNKNOWN_TAG", "One of those tags doesn't exist");
  }
}

/** Who a new lead belongs to (report §7.4): yourself by default; someone else only within your assign scope. */
async function resolveOwner(req: FastifyRequest, requested: string | null | undefined): Promise<string | null> {
  const actor = req.actor!;
  if (requested === undefined || requested === actor.userId) return actor.userId;
  if (requested === null) {
    if (!actor.isOwner && scopeOf(actor, "leads.assign") !== "all") throw forbidden("ASSIGN_OUT_OF_SCOPE", "You can't leave leads unassigned");
    return null;
  }
  if (!canOnRecord(actor, "leads.assign", requested) || !canOnRecord(actor, "leads.view", requested)) {
    throw forbidden("ASSIGN_OUT_OF_SCOPE", "You can't create leads for that person");
  }
  const [u] = await req.db.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.id, requested), eq(schema.users.status, "active")));
  if (!u) throw badRequest("UNKNOWN_USER", "That person doesn't exist or is disabled");
  return requested;
}

async function resolveStage(req: FastifyRequest, pipelineId: string | undefined, stageId: string | undefined) {
  const [pipeline] = pipelineId
    ? await req.db.select().from(schema.pipelines).where(and(eq(schema.pipelines.id, pipelineId), isNull(schema.pipelines.archivedAt)))
    : await req.db.select().from(schema.pipelines).where(and(eq(schema.pipelines.isDefault, true), isNull(schema.pipelines.archivedAt)));
  if (!pipeline) throw badRequest("UNKNOWN_PIPELINE", "That pipeline doesn't exist");
  const stages = await req.db
    .select()
    .from(schema.stages)
    .where(and(eq(schema.stages.pipelineId, pipeline.id), isNull(schema.stages.archivedAt)))
    .orderBy(schema.stages.position);
  const stage = stageId ? stages.find((s) => s.id === stageId) : stages.find((s) => s.kind === "open");
  if (!stage) throw badRequest("UNKNOWN_STAGE", "That stage isn't in this pipeline");
  if (stage.kind !== "open") throw badRequest("STAGE_NOT_OPEN", "New leads start in an open stage");
  return { pipelineId: pipeline.id, stageId: stage.id };
}

function contactColumns(input: LeadInput, defaultCountry: string | null) {
  const out: Partial<typeof L.$inferInsert> = {};
  let phone: NormalizedPhone | null = null;
  if ("phone" in input) {
    phone = normalizePhone(input.phone, defaultCountry);
    Object.assign(out, { phoneRaw: phone.raw, phoneE164: phone.e164, phoneCountryIso: phone.countryIso, phoneStatus: phone.status });
  }
  if ("email" in input) out.email = input.email ? input.email.toLowerCase() : null;
  if ("instagram" in input) out.instagramHandle = input.instagram ? normalizeInstagram(input.instagram) : null;
  return { out, phone };
}

async function setTags(req: FastifyRequest, leadId: string, tagIds: string[]) {
  await req.db.delete(schema.leadTags).where(eq(schema.leadTags.leadId, leadId));
  if (tagIds.length) await req.db.insert(schema.leadTags).values([...new Set(tagIds)].map((tagId) => ({ leadId, tagId })));
}

export async function createLead(req: FastifyRequest, input: LeadInput & { name: string }) {
  const fields = await loadFieldRegistry(req);
  assertWritable(req, fields, input);
  const custom = validateCustom(fields, input.custom, "create");
  await assertUsersExist(req, fields, custom);
  await assertRefs(req, input);
  const ownerId = await resolveOwner(req, input.ownerId);
  const { pipelineId, stageId } = await resolveStage(req, input.pipelineId, input.stageId);
  const { out: contact } = contactColumns(input, fields.defaultCountry);
  const duplicates = await findDuplicates(req, { phoneE164: contact.phoneE164, email: contact.email, instagram: contact.instagramHandle });

  const id = newId();
  const now = new Date();
  await req.db.insert(L).values({
    id,
    pipelineId,
    stageId,
    ownerId,
    name: input.name,
    ...contact,
    value: input.value ?? null,
    currency: input.currency ?? null,
    productId: input.productId ?? null,
    leadCreatedAt: input.leadCreatedAt ?? null,
    custom: Object.fromEntries(Object.entries(custom).filter(([, v]) => v !== null)),
    createdBy: req.actor!.userId,
    lastActivityAt: now,
    stageEnteredAt: now,
  });
  if (input.tagIds) await setTags(req, id, input.tagIds);
  await req.db.insert(schema.leadStageHistory).values({ leadId: id, fromStageId: null, toStageId: stageId, pipelineId, changedBy: req.actor!.userId });
  if (ownerId) await req.db.insert(schema.leadAssignmentHistory).values({ leadId: id, fromUserId: null, toUserId: ownerId, changedBy: req.actor!.userId, reason: "created" });
  await recordActivity(req, id, "lead_created", { source: "manual" });
  await audit(req, { action: "lead.create", entityType: "lead", entityId: id, diff: { ownerId, stageId } });
  return { lead: await leadViewFor(req, await visibleLead(req, id), fields), duplicates };
}

export async function getLead(req: FastifyRequest, id: string) {
  const row = await visibleLead(req, id);
  await audit(req, { action: "lead.view", entityType: "lead", entityId: id });
  return { lead: await leadViewFor(req, row) };
}

export function parseIfMatch(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) throw new HttpError(428, "PRECONDITION_REQUIRED", "Send If-Match with the version you edited");
  const m = /^(?:W\/)?"?(\d{1,9})"?$/.exec(raw.trim());
  if (!m) throw badRequest("BAD_IF_MATCH", "If-Match must be a lead version number");
  return Number(m[1]);
}

export async function updateLead(req: FastifyRequest, id: string, expectedVersion: number, input: LeadInput) {
  const fields = await loadFieldRegistry(req);
  const current = await visibleLead(req, id);
  if (!canOnRecord(req.actor!, "leads.edit", current.ownerId)) throw forbidden();
  if ("ownerId" in input || "stageId" in input || "pipelineId" in input) {
    throw badRequest("USE_DEDICATED_ENDPOINT", "Change the owner or stage with /assign or /stage");
  }
  assertWritable(req, fields, input);
  const custom = input.custom ? validateCustom(fields, input.custom, "patch") : {};
  await assertUsersExist(req, fields, custom);
  await assertRefs(req, input);
  const { out: contact } = contactColumns(input, fields.defaultCountry);

  const set: Record<string, unknown> = { ...contact };
  for (const k of ["name", "value", "currency", "productId", "leadCreatedAt"] as const) if (k in input) set[k] = input[k] ?? null;
  const removed = Object.entries(custom).filter(([, v]) => v === null).map(([k]) => k);
  const merged = Object.fromEntries(Object.entries(custom).filter(([, v]) => v !== null));
  const changed = [...Object.keys(set), ...Object.keys(custom).map((k) => `custom.${k}`), ...(input.tagIds ? ["tags"] : [])];

  const updated = await req.db
    .update(L)
    .set({
      ...set,
      ...(input.custom ? { custom: sql`(${L.custom} || ${JSON.stringify(merged)}::jsonb) - ${removed}::text[]` } : {}),
      version: sql`${L.version} + 1`,
      lastActivityAt: new Date(),
    })
    .where(and(eq(L.id, id), eq(L.version, expectedVersion), isNull(L.deletedAt)))
    .returning({ id: L.id });
  if (updated.length === 0) {
    throw new HttpError(409, "VERSION_CONFLICT", "Someone else changed this lead. Reload and try again.", { currentVersion: current.version });
  }
  if (input.tagIds) await setTags(req, id, input.tagIds);
  // Field names only, never values: contact changes must not leak into history.
  const fieldKeys = changed.map((c) => c.replace(/^custom\./, "")).map((k) => ({ phoneRaw: "phone", phoneE164: "phone", phoneCountryIso: "phone", phoneStatus: "phone", instagramHandle: "instagram" })[k] ?? k);
  const fieldList = [...new Set(fieldKeys)];
  await recordActivity(req, id, "field_changed", { fields: fieldList });
  await audit(req, { action: "lead.update", entityType: "lead", entityId: id, diff: { fields: fieldList } });
  return { lead: await leadViewFor(req, await visibleLead(req, id), fields) };
}

export async function deleteLead(req: FastifyRequest, id: string) {
  const current = await visibleLead(req, id);
  if (!canOnRecord(req.actor!, "leads.delete", current.ownerId)) throw forbidden();
  await req.db.update(L).set({ deletedAt: new Date(), version: sql`${L.version} + 1` }).where(eq(L.id, id));
  await audit(req, { action: "lead.delete", entityType: "lead", entityId: id });
}

```

`apps/api/src/modules/leads/routes.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { INSTAGRAM_RE, normalizePhone } from "@lume/core";
import { loadFieldRegistry } from "../../leads/fields";
import { findDuplicates } from "./duplicates";
import { listLeads } from "./query";
import * as svc from "./service";

const params = z.object({ id: z.uuid() });
const money = z.number().nonnegative().max(1e12);
const leadBody = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().max(40).nullable().optional(),
  email: z.email().max(254).nullable().optional(),
  instagram: z.string().regex(INSTAGRAM_RE).nullable().optional(),
  pipelineId: z.uuid().optional(),
  stageId: z.uuid().optional(),
  ownerId: z.uuid().nullable().optional(),
  value: money.nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  productId: z.uuid().nullable().optional(),
  leadCreatedAt: z.iso.date().nullable().optional(),
  tagIds: z.array(z.uuid()).max(50).optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});
const listQuery = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  sort: z.enum(["newest", "oldest", "updated", "name"]).default("newest"),
  pipelineId: z.uuid().optional(),
  stageId: z.string().regex(/^[0-9a-f-]{36}(,[0-9a-f-]{36}){0,19}$/).optional(),
  ownerId: z.union([z.uuid(), z.enum(["me", "none"])]).optional(),
  tagId: z.uuid().optional(),
  phoneStatus: z.enum(["valid", "needs_country", "invalid", "missing"]).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  createdFrom: z.iso.date().optional(),
  createdTo: z.iso.date().optional(),
  custom: z.string().max(2000).optional(),
});

export async function leadRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/leads", { config: { permission: "leads.view" }, schema: { querystring: listQuery } }, (req) => listLeads(req, req.query));
  r.post("/api/v1/leads", { config: { permission: "leads.create" }, schema: { body: leadBody } }, async (req, reply) =>
    reply.code(201).send(await svc.createLead(req, req.body)),
  );
  r.get(
    "/api/v1/leads/duplicates",
    {
      config: { permission: "leads.create" },
      schema: { querystring: z.object({ phone: z.string().max(40).optional(), email: z.email().max(254).optional(), instagram: z.string().regex(INSTAGRAM_RE).optional() }) },
    },
    async (req) => {
      const fields = await loadFieldRegistry(req);
      const phone = req.query.phone ? normalizePhone(req.query.phone, fields.defaultCountry) : null;
      return { duplicates: await findDuplicates(req, { phoneE164: phone?.e164, email: req.query.email, instagram: req.query.instagram?.replace(/^@/, "") }) };
    },
  );
  r.get("/api/v1/leads/:id", { config: { permission: "leads.view" }, schema: { params } }, (req) => svc.getLead(req, req.params.id));
  r.patch("/api/v1/leads/:id", { config: { permission: "leads.edit" }, schema: { params, body: leadBody.partial().strict() } }, (req) =>
    svc.updateLead(req, req.params.id, svc.parseIfMatch(req.headers["if-match"]), req.body),
  );
  r.delete("/api/v1/leads/:id", { config: { permission: "leads.delete" }, schema: { params } }, async (req, reply) => {
    await svc.deleteLead(req, req.params.id);
    return reply.code(204).send();
  });
}
```
Register `leadRoutes` in `app.ts`. Remove the `it.skip` in `pipelines.test.ts`.

- [ ] **Step 4: Run to verify**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/api/src/modules/leads apps/api/src/modules/pipelines && pnpm lint && pnpm typecheck'`
Expected: all pass except the activities test, which is skipped until Task 7.

- [ ] **Step 5: Commit and push** (add probes for the new routes first, as in Task 5 Step 4)

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(api): leads create/read/list/edit/delete with masking serializer, field access, If-Match concurrency, hashed duplicate warnings

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 7: Stage moves, assignment, notes, activities, Reveal

**Files:**
- Create: `apps/api/src/modules/leads/write.ts`, `apps/api/src/modules/leads/reveal.ts`, `apps/api/src/modules/leads/write.test.ts`
- Modify: `apps/api/src/modules/leads/routes.ts`, `apps/api/src/modules/leads/leads.test.ts` (un-skip)

**Interfaces:**
- Produces:
  - `moveStage(req, lead: LeadRow, input: { stageId; lostReasonId?; lostNote? }): Promise<LeadRow>` and `assignLead(req, lead: LeadRow, input: { ownerId: string | null; reason? }): Promise<{ visible: boolean }>`. Both throw `HttpError` and are reused by bulk.
  - Routes:
    - `POST /leads/:id/stage` (leads.change_stage) → `{ lead }`
    - `POST /leads/:id/assign` (leads.assign) → `{ id, ownerId, visible }`
    - `POST /leads/:id/notes` (leads.edit) `{ body }` → 201 `{ activity }`
    - `GET /leads/:id/activities` (leads.view) `?cursor&limit` → `{ items, nextCursor }`
    - `POST /leads/:id/contact/reveal` (leads.contact.reveal, `idempotent: false`) → `{ phone, email, instagram }`

- [ ] **Step 1: Write the failing tests**

`apps/api/src/modules/leads/write.test.ts`:
```ts
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";

let h: Harness;
let admin: AuthedClient;
let repUser: SeededUser;
let rep: AuthedClient;
let cfg: Awaited<ReturnType<Harness["config"]>>;
const SALES = [
  { key: "leads.view", scope: "own" },
  { key: "leads.edit", scope: "own" },
  { key: "leads.change_stage", scope: "own" },
  { key: "leads.contact.reveal", scope: "own" },
] as const;

beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
  cfg = await h.config();
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
  repUser = await h.seedUser({ grants: [...SALES] });
  rep = await h.signIn(repUser);
});
afterAll(async () => h.close());

const stage = (c: AuthedClient, id: string, body: object) => c.inject({ method: "POST", url: `/api/v1/leads/${id}/stage`, payload: body });

describe("stage moves (report §5.3, §14)", () => {
  it("moves, records history and bumps version; won and lost stamp their dates", async () => {
    const id = await h.seedLead({ ownerId: repUser.id });
    const moved = (await stage(rep, id, { stageId: cfg.stages["Call booked"] })).json().lead;
    expect(moved).toMatchObject({ stageId: cfg.stages["Call booked"], version: 2 });
    const won = (await stage(rep, id, { stageId: cfg.stages.Won })).json().lead;
    expect(won.wonAt).not.toBeNull();
    const back = (await stage(rep, id, { stageId: cfg.stages.New })).json().lead;
    expect(back.wonAt).toBeNull();
    const { rows } = await h.ownerPool.query(
      "SELECT count(*)::int n FROM lead_stage_history WHERE lead_id = $1 AND changed_by = $2",
      [id, repUser.id],
    );
    expect(rows[0].n).toBe(3);
  });

  it("Lost requires an active lost reason", async () => {
    const id = await h.seedLead({ ownerId: repUser.id });
    expect((await stage(rep, id, { stageId: cfg.stages.Lost })).json().error.code).toBe("LOST_REASON_REQUIRED");
    const lost = (await stage(rep, id, { stageId: cfg.stages.Lost, lostReasonId: cfg.lostReasons[0], lostNote: "Went quiet" })).json().lead;
    expect(lost).toMatchObject({ lostReasonId: cfg.lostReasons[0], lostNote: "Went quiet" });
    expect(lost.lostAt).not.toBeNull();
  });

  it("enforces the target stage's required fields", async () => {
    await admin.inject({ method: "PATCH", url: `/api/v1/stages/${cfg.stages["Call done"]}`, payload: { requiredFieldIds: [cfg.fields.email] } });
    const id = await h.seedLead({ ownerId: repUser.id });
    const r = await stage(rep, id, { stageId: cfg.stages["Call done"] });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatchObject({ code: "REQUIRED_FIELDS", details: { fields: ["email"] } });
    await admin.inject({ method: "PATCH", url: `/api/v1/stages/${cfg.stages["Call done"]}`, payload: { requiredFieldIds: [] } });
  });

  it("an out-of-scope lead can't be moved (404)", async () => {
    const other = await h.seedUser({ grants: [] });
    const id = await h.seedLead({ ownerId: other.id });
    expect((await stage(rep, id, { stageId: cfg.stages.Replied })).statusCode).toBe(404);
  });
});

describe("assignment (report §7.4 #4)", () => {
  it("reassigning a lead removes the previous rep's access immediately", async () => {
    const mate = await h.seedUser({ grants: [...SALES] });
    const id = await h.seedLead({ ownerId: repUser.id });
    expect((await rep.inject({ method: "GET", url: `/api/v1/leads/${id}` })).statusCode).toBe(200);
    const r = await admin.inject({ method: "POST", url: `/api/v1/leads/${id}/assign`, payload: { ownerId: mate.id, reason: "rebalance" } });
    expect(r.json()).toEqual({ id, ownerId: mate.id, visible: true });
    expect((await rep.inject({ method: "GET", url: `/api/v1/leads/${id}` })).statusCode).toBe(404);
    expect((await rep.inject({ method: "GET", url: `/api/v1/leads/${id}/activities` })).statusCode).toBe(404);
    expect((await (await h.signIn(mate)).inject({ method: "GET", url: `/api/v1/leads/${id}` })).statusCode).toBe(200);
  });

  it("a rep who may assign their own leads can hand one away and loses sight of it", async () => {
    const assigner = await h.seedUser({ grants: [...SALES, { key: "leads.assign", scope: "own" }] });
    const c = await h.signIn(assigner);
    const mate = await h.seedUser({ grants: [] });
    const id = await h.seedLead({ ownerId: assigner.id });
    const r = await c.inject({ method: "POST", url: `/api/v1/leads/${id}/assign`, payload: { ownerId: mate.id } });
    expect(r.json()).toEqual({ id, ownerId: mate.id, visible: false });
    expect((await c.inject({ method: "GET", url: `/api/v1/leads/${id}` })).statusCode).toBe(404);
  });

  it("refuses disabled users and unassigning below all scope", async () => {
    const off = await h.seedUser({ grants: [], status: "disabled" });
    const id = await h.seedLead({ ownerId: repUser.id });
    expect((await admin.inject({ method: "POST", url: `/api/v1/leads/${id}/assign`, payload: { ownerId: off.id } })).json().error.code).toBe("UNKNOWN_USER");
    const assigner = await h.signIn(await h.seedUser({ grants: [...SALES, { key: "leads.assign", scope: "own" }] }));
    expect((await assigner.inject({ method: "POST", url: `/api/v1/leads/${id}/assign`, payload: { ownerId: null } })).statusCode).toBe(404);
  });
});

describe("notes and activities", () => {
  it("adds a note and lists activities newest first", async () => {
    const id = await h.seedLead({ ownerId: repUser.id });
    const n = await rep.inject({ method: "POST", url: `/api/v1/leads/${id}/notes`, payload: { body: "Prefers evenings" } });
    expect(n.statusCode).toBe(201);
    await stage(rep, id, { stageId: cfg.stages.Replied });
    const acts = (await rep.inject({ method: "GET", url: `/api/v1/leads/${id}/activities` })).json().items;
    expect(acts.map((a: { type: string }) => a.type).slice(0, 2)).toEqual(["stage_changed", "note"]);
    expect(acts[1]).toMatchObject({ payload: { body: "Prefers evenings" }, user: { id: repUser.id } });
  });
});

describe("Reveal (report §12.2 #3)", () => {
  it("shows one lead's full contact, meters and audits it, and never caches it", async () => {
    const id = await h.seedLead({ ownerId: repUser.id, phone: "+971501234567", email: "reveal@example.com" });
    const r = await rep.inject({ method: "POST", url: `/api/v1/leads/${id}/contact/reveal`, headers: { "idempotency-key": "reveal-key-0001" } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ phone: "+971 50 123 4567", email: "reveal@example.com", instagram: null });
    expect(r.headers["cache-control"]).toBe("no-store");
    expect((await h.pool.query("SELECT count FROM reveal_counters WHERE user_id = $1", [repUser.id])).rows[0].count).toBe(1);
    expect((await h.pool.query("SELECT count(*)::int n FROM audit_log WHERE action = 'lead.contact.reveal' AND entity_id = $1", [id])).rows[0].n).toBe(1);
    expect((await h.pool.query("SELECT count(*)::int n FROM idempotency_keys WHERE key = 'reveal-key-0001'")).rows[0].n).toBe(0);
  });

  it("needs the reveal permission and scope", async () => {
    const other = await h.seedUser({ grants: [] });
    const theirs = await h.seedLead({ ownerId: other.id, phone: "+971501234567" });
    expect((await rep.inject({ method: "POST", url: `/api/v1/leads/${theirs}/contact/reveal` })).statusCode).toBe(404);
    const viewer = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] });
    const mine = await h.seedLead({ ownerId: viewer.id, phone: "+971501234567" });
    expect((await (await h.signIn(viewer)).inject({ method: "POST", url: `/api/v1/leads/${mine}/contact/reveal` })).statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `scripts/dev.sh run pnpm vitest run apps/api/src/modules/leads/write.test.ts`
Expected: FAIL (404s).

- [ ] **Step 3: Implement**

`apps/api/src/modules/leads/write.ts`:
```ts
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { canOnRecord, newId, scopeOf } from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, forbidden } from "../../http/errors";
import { loadFieldRegistry } from "../../leads/fields";
import type { LeadRow } from "./serialize";
import { recordActivity, visibleLead } from "./service";

const L = schema.leads;

/** Is a core or custom field filled on this lead? (stage required-field rule, report §14) */
function hasValue(lead: LeadRow, key: string): boolean {
  const core: Record<string, unknown> = {
    name: lead.name,
    phone: lead.phoneE164 ?? lead.phoneRaw,
    email: lead.email,
    instagram: lead.instagramHandle,
    owner: lead.ownerId,
    stage: lead.stageId,
    source: lead.sourceId,
    value: lead.value,
    lead_created_at: lead.leadCreatedAt,
  };
  const v = key in core ? core[key] : lead.custom?.[key];
  return v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);
}

export async function moveStage(req: FastifyRequest, lead: LeadRow, input: { stageId: string; lostReasonId?: string; lostNote?: string }): Promise<LeadRow> {
  const actor = req.actor!;
  if (!canOnRecord(actor, "leads.change_stage", lead.ownerId)) throw forbidden();
  const [target] = await req.db.select().from(schema.stages).where(and(eq(schema.stages.id, input.stageId), isNull(schema.stages.archivedAt)));
  if (!target) throw badRequest("UNKNOWN_STAGE", "That stage doesn't exist");
  if (target.id === lead.stageId && target.kind !== "lost") return lead;

  const fields = await loadFieldRegistry(req);
  const missing = target.requiredFieldIds
    .map((id) => fields.byId.get(id))
    .filter((d): d is NonNullable<typeof d> => !!d && !d.archived)
    .filter((d) => !hasValue(lead, d.key))
    .map((d) => d.key);
  if (missing.length) throw new HttpError(422, "REQUIRED_FIELDS", "Fill these in before moving to this stage", { fields: missing });

  const now = new Date();
  const set: Partial<typeof L.$inferInsert> = { stageId: target.id, pipelineId: target.pipelineId, stageEnteredAt: now, lastActivityAt: now };
  if (target.kind === "lost") {
    if (!input.lostReasonId) throw badRequest("LOST_REASON_REQUIRED", "Pick a reason this lead was lost");
    const [reason] = await req.db.select({ id: schema.lostReasons.id }).from(schema.lostReasons).where(and(eq(schema.lostReasons.id, input.lostReasonId), isNull(schema.lostReasons.archivedAt)));
    if (!reason) throw badRequest("UNKNOWN_LOST_REASON", "That lost reason doesn't exist");
    Object.assign(set, { lostAt: now, wonAt: null, lostReasonId: reason.id, lostNote: input.lostNote ?? null });
  } else if (target.kind === "won") {
    Object.assign(set, { wonAt: now, lostAt: null, lostReasonId: null, lostNote: null });
  } else {
    Object.assign(set, { wonAt: null, lostAt: null, lostReasonId: null, lostNote: null });
  }

  await req.db.insert(schema.leadStageHistory).values({ leadId: lead.id, fromStageId: lead.stageId, toStageId: target.id, pipelineId: target.pipelineId, changedBy: actor.userId });
  await recordActivity(req, lead.id, "stage_changed", { from: lead.stageId, to: target.id });
  await req.db.update(L).set({ ...set, version: sql`${L.version} + 1` }).where(eq(L.id, lead.id));
  await audit(req, { action: "lead.stage", entityType: "lead", entityId: lead.id, diff: { from: lead.stageId, to: target.id } });
  return visibleLead(req, lead.id);
}

/**
 * Report §7.4 #4. History and activity are written *before* the owner changes: once it does, the caller
 * may no longer see the lead (and RLS would refuse the child rows).
 */
export async function assignLead(req: FastifyRequest, lead: LeadRow, input: { ownerId: string | null; reason?: string }): Promise<{ visible: boolean }> {
  const actor = req.actor!;
  if (!canOnRecord(actor, "leads.assign", lead.ownerId)) throw forbidden();
  if (input.ownerId === lead.ownerId) return { visible: true };
  if (input.ownerId === null) {
    if (!actor.isOwner && scopeOf(actor, "leads.assign") !== "all") throw forbidden("ASSIGN_OUT_OF_SCOPE", "You can't leave leads unassigned");
  } else {
    const [u] = await req.db.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.id, input.ownerId), eq(schema.users.status, "active")));
    if (!u) throw badRequest("UNKNOWN_USER", "That person doesn't exist or is disabled");
  }
  await req.db.insert(schema.leadAssignmentHistory).values({ leadId: lead.id, fromUserId: lead.ownerId, toUserId: input.ownerId, changedBy: actor.userId, reason: input.reason ?? null });
  await recordActivity(req, lead.id, "assigned", { from: lead.ownerId, to: input.ownerId });
  await req.db.update(L).set({ ownerId: input.ownerId, lastActivityAt: new Date(), version: sql`${L.version} + 1` }).where(eq(L.id, lead.id));
  await audit(req, { action: "lead.assign", entityType: "lead", entityId: lead.id, diff: { from: lead.ownerId, to: input.ownerId } });
  return { visible: canOnRecord(actor, "leads.view", input.ownerId) };
}

export async function addNote(req: FastifyRequest, lead: LeadRow, body: string) {
  if (!canOnRecord(req.actor!, "leads.edit", lead.ownerId)) throw forbidden();
  const id = newId();
  await req.db.insert(schema.activities).values({ id, leadId: lead.id, userId: req.actor!.userId, type: "note", payload: { body } });
  await req.db.update(L).set({ lastActivityAt: new Date() }).where(eq(L.id, lead.id));
  return { activity: { id, type: "note", payload: { body } } };
}

export async function listActivities(req: FastifyRequest, lead: LeadRow, q: { cursor?: string; limit: number }) {
  const A = schema.activities;
  const where = q.cursor ? and(eq(A.leadId, lead.id), lt(A.id, q.cursor)) : eq(A.leadId, lead.id);
  // Activity ids are UUID v7 (time-ordered), so id order is occurrence order for app-written rows.
  const rows = await req.db
    .select({ id: A.id, type: A.type, payload: A.payload, occurredAt: A.occurredAt, userId: A.userId, userName: schema.users.name })
    .from(A)
    .leftJoin(schema.users, eq(schema.users.id, A.userId))
    .where(where)
    .orderBy(desc(A.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  return {
    items: page.map((r) => ({ id: r.id, type: r.type, payload: r.payload, occurredAt: r.occurredAt, user: r.userId ? { id: r.userId, name: r.userName } : null })),
    nextCursor: rows.length > q.limit ? page.at(-1)!.id : null,
  };
}
```

`apps/api/src/modules/leads/reveal.ts`:
```ts
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { canOnRecord, formatPhone } from "@lume/core";
import { audit } from "../../audit/audit";
import { forbidden } from "../../http/errors";
import { loadFieldRegistry } from "../../leads/fields";
import { isFieldVisible } from "./serialize";
import { recordActivity, visibleLead } from "./service";

/** Report §12.2 #3: one lead's contact on click, audited and counted per user per hour. */
export async function revealContact(req: FastifyRequest, id: string) {
  const actor = req.actor!;
  const lead = await visibleLead(req, id);
  if (!canOnRecord(actor, "leads.contact.reveal", lead.ownerId) && !canOnRecord(actor, "leads.contact.full", lead.ownerId)) throw forbidden();
  const fields = await loadFieldRegistry(req);
  const ctx = { actor, fields };
  const out = {
    phone: isFieldVisible(ctx, "phone") ? (lead.phoneE164 ? formatPhone(lead.phoneE164) : lead.phoneRaw) : null,
    email: isFieldVisible(ctx, "email") ? (lead.email?.toLowerCase() ?? null) : null,
    instagram: isFieldVisible(ctx, "instagram") && lead.instagramHandle ? `@${lead.instagramHandle}` : null,
  };
  await req.db.execute(sql`
    INSERT INTO reveal_counters (user_id, hour, count) VALUES (${actor.userId}, date_trunc('hour', now()), 1)
    ON CONFLICT (user_id, hour) DO UPDATE SET count = reveal_counters.count + 1`);
  await recordActivity(req, id, "contact_revealed");
  await audit(req, { action: "lead.contact.reveal", entityType: "lead", entityId: id });
  return out;
}
```

Add to `apps/api/src/modules/leads/routes.ts`:
```ts
  r.post(
    "/api/v1/leads/:id/stage",
    { config: { permission: "leads.change_stage" }, schema: { params, body: z.object({ stageId: z.uuid(), lostReasonId: z.uuid().optional(), lostNote: z.string().trim().max(1000).optional() }) } },
    async (req) => {
      const lead = await moveStage(req, await svc.visibleLead(req, req.params.id), req.body);
      return { lead: await svc.leadViewFor(req, lead) };
    },
  );
  r.post(
    "/api/v1/leads/:id/assign",
    { config: { permission: "leads.assign" }, schema: { params, body: z.object({ ownerId: z.uuid().nullable(), reason: z.string().trim().max(200).optional() }) } },
    async (req) => {
      const { visible } = await assignLead(req, await svc.visibleLead(req, req.params.id), req.body);
      return { id: req.params.id, ownerId: req.body.ownerId, visible };
    },
  );
  r.post("/api/v1/leads/:id/notes", { config: { permission: "leads.edit" }, schema: { params, body: z.object({ body: z.string().trim().min(1).max(5000) }) } }, async (req, reply) =>
    reply.code(201).send(await addNote(req, await svc.visibleLead(req, req.params.id), req.body.body)),
  );
  r.get(
    "/api/v1/leads/:id/activities",
    { config: { permission: "leads.view" }, schema: { params, querystring: z.object({ cursor: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }) } },
    async (req) => listActivities(req, await svc.visibleLead(req, req.params.id), req.query),
  );
  r.post(
    "/api/v1/leads/:id/contact/reveal",
    { config: { permission: "leads.contact.reveal", idempotent: false }, schema: { params } },
    async (req, reply) => {
      void reply.header("cache-control", "no-store");
      return revealContact(req, req.params.id);
    },
  );
```
(Imports: `moveStage, assignLead, addNote, listActivities` from `./write` and `revealContact` from `./reveal`.)

**Route permission for Reveal:** the route guard requires `leads.contact.reveal`, so a role holding only `leads.contact.full` would get 403 from the guard. Admins hold both, so that case never arises in practice. Keep the guard permission as `leads.contact.reveal`.

Un-skip the activities test in `leads.test.ts`.

- [ ] **Step 4: Run to verify**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/api/src/modules/leads && pnpm lint && pnpm typecheck'`
Expected: all pass.

- [ ] **Step 5: Commit and push** (probes for the new routes, as before)

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(api): stage moves with required fields and lost reasons, assignment that revokes access, notes, activities, metered Reveal

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 8: Bulk actions

**Files:**
- Create: `apps/api/src/modules/leads/bulk.ts`, `apps/api/src/modules/leads/bulk.test.ts`
- Modify: `apps/api/src/modules/leads/routes.ts`

**Interfaces:**
- Produces:
  - `POST /leads/bulk` (leads.bulk_edit) `{ ids: uuid[1..100], action }`, where `action` is one of:
    - `{ type: "stage", stageId, lostReasonId? }`
    - `{ type: "assign", ownerId }`
    - `{ type: "tags", add?, remove? }`
    - `{ type: "delete" }`
  - Returns `{ updated: string[], skipped: { id, code }[] }`. Each lead is checked individually (bulk_edit scope, the action's own permission, RLS). One failure doesn't undo the others (savepoint per lead). Out-of-scope ids are skipped as `LEAD_NOT_FOUND`.

- [ ] **Step 1: Write the failing test**

`apps/api/src/modules/leads/bulk.test.ts`:
```ts
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
let admin: AuthedClient;
let cfg: Awaited<ReturnType<Harness["config"]>>;
beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
  cfg = await h.config();
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
});
afterAll(async () => h.close());

const bulk = (c: AuthedClient, body: object) => c.inject({ method: "POST", url: "/api/v1/leads/bulk", payload: body });

describe("bulk actions (report §14)", () => {
  it("moves many leads, skipping ones that can't move without undoing the rest", async () => {
    const owner = await h.seedUser({ grants: [] });
    const ids = [await h.seedLead({ ownerId: owner.id }), await h.seedLead({ ownerId: owner.id })];
    const r = await bulk(admin, { ids: [...ids, "0190e0c0-0000-7000-8000-00000000dead"], action: { type: "stage", stageId: cfg.stages.Lost } });
    expect(r.json()).toEqual({
      updated: [],
      skipped: [
        { id: ids[0], code: "LOST_REASON_REQUIRED" },
        { id: ids[1], code: "LOST_REASON_REQUIRED" },
        { id: "0190e0c0-0000-7000-8000-00000000dead", code: "LEAD_NOT_FOUND" },
      ],
    });
    const ok = await bulk(admin, { ids, action: { type: "stage", stageId: cfg.stages.Replied } });
    expect(ok.json()).toEqual({ updated: ids, skipped: [] });
  });

  it("tags, reassigns and deletes", async () => {
    const tag = (await admin.inject({ method: "POST", url: "/api/v1/tags", payload: { label: "Hot" } })).json().tag;
    const a = await h.seedUser({ grants: [] });
    const b = await h.seedUser({ grants: [] });
    const ids = [await h.seedLead({ ownerId: a.id }), await h.seedLead({ ownerId: a.id })];
    expect((await bulk(admin, { ids, action: { type: "tags", add: [tag.id] } })).json().updated).toEqual(ids);
    expect((await admin.inject({ method: "GET", url: `/api/v1/leads?tagId=${tag.id}` })).json().items).toHaveLength(2);
    expect((await bulk(admin, { ids, action: { type: "assign", ownerId: b.id } })).json().updated).toEqual(ids);
    expect((await bulk(admin, { ids, action: { type: "delete" } })).json().updated).toEqual(ids);
    expect((await admin.inject({ method: "GET", url: `/api/v1/leads/${ids[0]}` })).statusCode).toBe(404);
  });

  it("a scoped bulk editor only touches leads in scope, and needs the action's permission too", async () => {
    const u = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }, { key: "leads.bulk_edit", scope: "own" }, { key: "leads.change_stage", scope: "own" }] });
    const c = await h.signIn(u);
    const mine = await h.seedLead({ ownerId: u.id });
    const other = await h.seedUser({ grants: [] });
    const theirs = await h.seedLead({ ownerId: other.id });
    const r = await bulk(c, { ids: [mine, theirs], action: { type: "stage", stageId: cfg.stages.Replied } });
    expect(r.json()).toEqual({ updated: [mine], skipped: [{ id: theirs, code: "LEAD_NOT_FOUND" }] });
    const del = await bulk(c, { ids: [mine], action: { type: "delete" } });
    expect(del.json()).toEqual({ updated: [], skipped: [{ id: mine, code: "FORBIDDEN" }] });
    expect((await bulk(c, { ids: Array.from({ length: 101 }, () => mine), action: { type: "delete" } })).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/dev.sh run pnpm vitest run apps/api/src/modules/leads/bulk.test.ts`
Expected: FAIL (404).

- [ ] **Step 3: Implement**

`apps/api/src/modules/leads/bulk.ts`:
```ts
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { canOnRecord } from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, forbidden } from "../../http/errors";
import { deleteLead, recordActivity, visibleLead } from "./service";
import { assignLead, moveStage } from "./write";

export type BulkAction =
  | { type: "stage"; stageId: string; lostReasonId?: string }
  | { type: "assign"; ownerId: string | null }
  | { type: "tags"; add?: string[]; remove?: string[] }
  | { type: "delete" };

/**
 * Report §14 bulk actions. Every lead is checked on its own (scope, bulk_edit, the action's permission,
 * RLS); a refusal is reported and rolled back to a savepoint without disturbing the others.
 */
export async function runBulk(req: FastifyRequest, ids: string[], action: BulkAction) {
  const unique = [...new Set(ids)];
  if (action.type === "tags") {
    const all = [...(action.add ?? []), ...(action.remove ?? [])];
    if (!all.length) throw badRequest("NOTHING_TO_DO", "Add or remove at least one tag");
    const found = await req.db.select({ id: schema.tags.id }).from(schema.tags).where(inArray(schema.tags.id, all));
    if (found.length !== new Set(all).size) throw badRequest("UNKNOWN_TAG", "One of those tags doesn't exist");
  }
  const updated: string[] = [];
  const skipped: { id: string; code: string }[] = [];
  for (const [i, id] of unique.entries()) {
    const sp = sql.raw(`bulk_${i}`);
    await req.db.execute(sql`SAVEPOINT ${sp}`);
    try {
      const lead = await visibleLead(req, id);
      if (!canOnRecord(req.actor!, "leads.bulk_edit", lead.ownerId)) throw forbidden();
      switch (action.type) {
        case "stage":
          await moveStage(req, lead, { stageId: action.stageId, lostReasonId: action.lostReasonId });
          break;
        case "assign":
          await assignLead(req, lead, { ownerId: action.ownerId, reason: "bulk" });
          break;
        case "delete":
          await deleteLead(req, id);
          break;
        case "tags":
          if (!canOnRecord(req.actor!, "leads.edit", lead.ownerId)) throw forbidden();
          if (action.remove?.length) await req.db.delete(schema.leadTags).where(and(eq(schema.leadTags.leadId, id), inArray(schema.leadTags.tagId, action.remove)));
          if (action.add?.length) await req.db.insert(schema.leadTags).values(action.add.map((tagId) => ({ leadId: id, tagId }))).onConflictDoNothing();
          await req.db.update(schema.leads).set({ version: sql`${schema.leads.version} + 1` }).where(eq(schema.leads.id, id));
          await recordActivity(req, id, "field_changed", { fields: ["tags"] });
          break;
      }
      await req.db.execute(sql`RELEASE SAVEPOINT ${sp}`);
      updated.push(id);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err; // real failures still roll the whole request back
      await req.db.execute(sql`ROLLBACK TO SAVEPOINT ${sp}`);
      skipped.push({ id, code: err.code });
    }
  }
  await audit(req, { action: "lead.bulk", entityType: "lead", diff: { type: action.type, updated: updated.length, skipped: skipped.length } });
  return { updated, skipped };
}
```

Add to `routes.ts` (register **before** `/api/v1/leads/:id` routes is not required, since Fastify prefers static segments, but keep it next to them):
```ts
  r.post(
    "/api/v1/leads/bulk",
    {
      config: { permission: "leads.bulk_edit" },
      schema: {
        body: z.object({
          ids: z.array(z.uuid()).min(1).max(100),
          action: z.discriminatedUnion("type", [
            z.object({ type: z.literal("stage"), stageId: z.uuid(), lostReasonId: z.uuid().optional() }),
            z.object({ type: z.literal("assign"), ownerId: z.uuid().nullable() }),
            z.object({ type: z.literal("tags"), add: z.array(z.uuid()).max(20).optional(), remove: z.array(z.uuid()).max(20).optional() }),
            z.object({ type: z.literal("delete") }),
          ]),
        }),
      },
    },
    (req) => runBulk(req, req.body.ids, req.body.action),
  );
```

- [ ] **Step 4: Run to verify**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/api/src/modules/leads && pnpm lint && pnpm typecheck'`
Expected: bulk (3) passes with the rest.

- [ ] **Step 5: Commit and push** (with a probe for `POST /api/v1/leads/bulk`)

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(api): bulk stage/assign/tags/delete, checked lead by lead with savepoints

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 9: Access matrix over every lead route, in and out of scope

**Files:**
- Modify: `apps/api/test/probes.ts`, `apps/api/test/matrix.test.ts`

**Interfaces:**
- Consumes: the harness `seedLead`/`config`, all routes.
- Produces: probes for every 1B route (`Fixtures` gains `leadId, leadToDelete, pipelineId, pipelineToArchive, stageId, stageToArchive, fieldId, fieldToArchive, lostReasonId, lostReasonToArchive, tagId, tagToDelete, productId, productToArchive`), plus a scope test. As `sales`, every `/api/v1/leads/:id…` route answers 404 on an out-of-scope lead and not 404 on an in-scope one. As a team lead, a member's lead is visible and an outsider's isn't.

- [ ] **Step 1: Fixtures**

In `matrix.test.ts` `beforeAll`, after the 1A fixtures:
```ts
  const cfg = await h.config();
  const admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
  const mk = async (url: string, payload: object, pick: (j: any) => string) => pick((await admin.inject({ method: "POST", url, payload })).json());
  const p2 = await mk("/api/v1/pipelines", { name: "Matrix P2" }, (j) => j.pipeline.id);
  const p3 = await mk("/api/v1/pipelines", { name: "Matrix P3" }, (j) => j.pipeline.id);
  fx = {
    ...fx,
    leadId: await h.seedLead({ ownerId: target.id }),
    leadToDelete: await h.seedLead({ ownerId: target.id }),
    pipelineId: p2,
    pipelineToArchive: p3,
    stageId: cfg.stages.New!,
    stageToArchive: await mk(`/api/v1/pipelines/${p2}/stages`, { name: "Doomed", kind: "open" }, (j) => j.stage.id),
    fieldId: cfg.fields.handled_by ?? (await mk("/api/v1/fields", { key: "matrix_f", label: "F", type: "text" }, (j) => j.field.id)),
    fieldToArchive: await mk("/api/v1/fields", { key: "matrix_doomed", label: "Doomed", type: "text" }, (j) => j.field.id),
    lostReasonId: cfg.lostReasons[0]!,
    lostReasonToArchive: await mk("/api/v1/lost-reasons", { label: "Matrix doomed" }, (j) => j.lostReason.id),
    tagId: await mk("/api/v1/tags", { label: "Matrix" }, (j) => j.tag.id),
    tagToDelete: await mk("/api/v1/tags", { label: "Matrix doomed" }, (j) => j.tag.id),
    productId: await mk("/api/v1/products", { name: "Matrix product" }, (j) => j.product.id),
    productToArchive: await mk("/api/v1/products", { name: "Matrix doomed" }, (j) => j.product.id),
  };
```
(`fx` becomes `let fx: Fixtures`, built in two steps. Keep `// eslint-disable-next-line @typescript-eslint/no-explicit-any` on the `mk` line if lint objects to `any`.)

- [ ] **Step 2: Probes (access table)**

Extend `Fixtures` in `probes.ts` with the fields above. Add these entries (the access values come from spec §4 and this plan's decision 9):
```ts
  "GET /api/v1/pipelines": { access: "leads.view" },
  "POST /api/v1/pipelines": { access: "pipelines.manage", body: () => ({ name: `MP-${Math.random()}` }) },
  "PATCH /api/v1/pipelines/:id": { access: "pipelines.manage", path: (f) => `/api/v1/pipelines/${f.pipelineId}`, body: () => ({ position: 5 }) },
  "POST /api/v1/pipelines/:id/archive": { access: "pipelines.manage", path: (f) => `/api/v1/pipelines/${f.pipelineToArchive}/archive` },
  "POST /api/v1/pipelines/:id/stages": { access: "pipelines.manage", path: (f) => `/api/v1/pipelines/${f.pipelineId}/stages`, body: () => ({ name: `S-${Math.random()}`.slice(0, 20), kind: "open" }) },
  "PUT /api/v1/pipelines/:id/stage-order": { access: "pipelines.manage", path: (f) => `/api/v1/pipelines/${f.pipelineId}/stage-order`, body: () => ({ stageIds: [uuid] }) },
  "PATCH /api/v1/stages/:id": { access: "pipelines.manage", path: (f) => `/api/v1/stages/${f.stageId}`, body: () => ({ color: "cyan" }) },
  "POST /api/v1/stages/:id/archive": { access: "pipelines.manage", path: (f) => `/api/v1/stages/${f.stageToArchive}/archive`, body: () => ({}) },
  "GET /api/v1/fields": { access: "leads.view" },
  "POST /api/v1/fields": { access: "fields.manage", body: () => ({ key: `mf_${Math.random().toString(36).slice(2, 10)}`, label: "M", type: "text" }) },
  "PATCH /api/v1/fields/:id": { access: "fields.manage", path: (f) => `/api/v1/fields/${f.fieldId}`, body: () => ({ position: 50 }) },
  "POST /api/v1/fields/:id/archive": { access: "fields.manage", path: (f) => `/api/v1/fields/${f.fieldToArchive}/archive` },
  "GET /api/v1/lost-reasons": { access: "leads.view" },
  "POST /api/v1/lost-reasons": { access: "pipelines.manage", body: () => ({ label: `LR-${Math.random()}`.slice(0, 30) }) },
  "PATCH /api/v1/lost-reasons/:id": { access: "pipelines.manage", path: (f) => `/api/v1/lost-reasons/${f.lostReasonId}`, body: () => ({ position: 9 }) },
  "POST /api/v1/lost-reasons/:id/archive": { access: "pipelines.manage", path: (f) => `/api/v1/lost-reasons/${f.lostReasonToArchive}/archive` },
  "GET /api/v1/tags": { access: "leads.view" },
  "POST /api/v1/tags": { access: "settings.manage", body: () => ({ label: `T-${Math.random()}`.slice(0, 30) }) },
  "PATCH /api/v1/tags/:id": { access: "settings.manage", path: (f) => `/api/v1/tags/${f.tagId}`, body: () => ({ color: "ok" }) },
  "DELETE /api/v1/tags/:id": { access: "settings.manage", path: (f) => `/api/v1/tags/${f.tagToDelete}` },
  "GET /api/v1/products": { access: "leads.view" },
  "POST /api/v1/products": { access: "settings.manage", body: () => ({ name: `P-${Math.random()}`.slice(0, 30) }) },
  "PATCH /api/v1/products/:id": { access: "settings.manage", path: (f) => `/api/v1/products/${f.productId}`, body: () => ({ defaultValue: 10 }) },
  "POST /api/v1/products/:id/archive": { access: "settings.manage", path: (f) => `/api/v1/products/${f.productToArchive}/archive` },
  "PUT /api/v1/roles/:id/field-access": { access: "roles.manage", path: (f) => `/api/v1/roles/${f.roleId}/field-access`, body: () => ({ entries: [] }) },
  "GET /api/v1/leads": { access: "leads.view", query: "limit=5" },
  "POST /api/v1/leads": { access: "leads.create", body: () => ({ name: "Matrix lead" }) },
  "GET /api/v1/leads/duplicates": { access: "leads.create", query: "email=nobody%40test.lume" },
  "POST /api/v1/leads/bulk": { access: "leads.bulk_edit", body: (f) => ({ ids: [f.leadId], action: { type: "tags", add: [f.tagId] } }) },
  "GET /api/v1/leads/:id": { access: "leads.view", path: (f) => `/api/v1/leads/${f.leadId}` },
  "PATCH /api/v1/leads/:id": { access: "leads.edit", path: (f) => `/api/v1/leads/${f.leadId}`, body: () => ({ name: "Renamed" }) },
  "DELETE /api/v1/leads/:id": { access: "leads.delete", path: (f) => `/api/v1/leads/${f.leadToDelete}` },
  "POST /api/v1/leads/:id/stage": { access: "leads.change_stage", path: (f) => `/api/v1/leads/${f.leadId}/stage`, body: (f) => ({ stageId: f.stageId }) },
  "POST /api/v1/leads/:id/assign": { access: "leads.assign", path: (f) => `/api/v1/leads/${f.leadId}/assign`, body: (f) => ({ ownerId: f.userId }) },
  "POST /api/v1/leads/:id/notes": { access: "leads.edit", path: (f) => `/api/v1/leads/${f.leadId}/notes`, body: () => ({ body: "Matrix note" }) },
  "GET /api/v1/leads/:id/activities": { access: "leads.view", path: (f) => `/api/v1/leads/${f.leadId}/activities` },
  "POST /api/v1/leads/:id/contact/reveal": { access: "leads.contact.reveal", path: (f) => `/api/v1/leads/${f.leadId}/contact/reveal` },
```
(PATCH `/leads/:id` without If-Match answers 428 for allowed actors, which still counts as "reached the route".)

- [ ] **Step 3: The scope test**

Append to `matrix.test.ts`:
```ts
describe("lead scope across every lead route (report §7.5: in and out of scope)", () => {
  it("a sales rep gets 404 on every route of someone else's lead, and reaches every route of their own", async () => {
    const sales = users.get("sales")!;
    const mine = await h.seedLead({ ownerId: sales.id });
    const other = await h.seedUser({ grants: [] });
    const theirs = await h.seedLead({ ownerId: other.id });
    const leadRoutes = apiRoutes().filter((r) => r.url.startsWith("/api/v1/leads/:id"));
    expect(leadRoutes.length).toBeGreaterThanOrEqual(8);
    const wrong: string[] = [];
    for (const route of leadRoutes) {
      const probe = PROBES[key(route)]!;
      for (const [id, expectHidden] of [[theirs, true], [mine, false]] as const) {
        const url = route.url.replace(":id", id) + (probe.query ? `?${probe.query}` : "");
        const res = await (await h.signIn(sales)).inject({
          method: route.method as "GET",
          url,
          headers: { "if-match": "1" },
          ...(probe.body ? { payload: { ...(probe.body(fx) as object) } } : {}),
        });
        const code = res.statusCode >= 400 ? res.json().error?.code : "";
        // Out of scope: always 404, even where the permission itself is missing (existence must not leak).
        const hiddenOk = res.statusCode === 404 || (res.statusCode === 403 && code === "FORBIDDEN" && !expectHidden);
        if (expectHidden && res.statusCode !== 404 && !(res.statusCode === 403 && code === "FORBIDDEN")) wrong.push(`${key(route)} on out-of-scope lead → ${res.statusCode} ${code}`);
        if (!expectHidden && res.statusCode === 404) wrong.push(`${key(route)} on own lead → 404`);
        void hiddenOk;
      }
    }
    expect(wrong).toEqual([]);
  });

  it("a team lead sees their members' leads and nobody else's", async () => {
    const lead = await h.seedUser({ grants: [{ key: "leads.view", scope: "team" }] });
    const member = await h.seedUser({ grants: [] });
    const outsider = await h.seedUser({ grants: [] });
    await h.seedTeam(lead.id, [member.id]);
    const theirs = await h.seedLead({ ownerId: member.id });
    const nope = await h.seedLead({ ownerId: outsider.id });
    const c = await h.signIn(lead);
    expect((await c.inject({ method: "GET", url: `/api/v1/leads/${theirs}` })).statusCode).toBe(200);
    expect((await c.inject({ method: "GET", url: `/api/v1/leads/${nope}` })).statusCode).toBe(404);
  });
});
```
A route-guard 403 (the rep lacks the permission entirely, e.g. `assign`) is allowed on the out-of-scope lead. The guard answers before any lookup, so it reveals nothing about that lead.

- [ ] **Step 4: Run it**

Run: `scripts/dev.sh run bash -c 'pnpm lint && pnpm typecheck && pnpm test'`
Expected: matrix (5 tests) green; the whole suite green.
**Mutation check (don't commit it):** change `GET /api/v1/leads/:id`'s permission to `auth.self`, then separately remove `isNull(L.deletedAt)` from `visibleLead`. Each must turn the matrix or the lead tests red. Revert both.

- [ ] **Step 5: Commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "test(api): access matrix covers every 1B route; lead routes proven 404 out of scope and reachable in scope

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 10: Live acceptance on the dev stack

- [ ] **Step 1: Rebuild and migrate**

Run: `scripts/dev.sh up`
Expected: migrations `0008`–`0010` applied; the stack is healthy. Run a backup on the live stack to prove backups work under RLS:
```bash
scripts/dev.sh compose exec -T worker node dist/main.js run-now ops.backup
scripts/dev.sh compose exec -T worker node dist/main.js run-now ops.restore-test
```
Expected: both succeed.

- [ ] **Step 2: Acceptance script**

Create `infra/scripts/acceptance-1b.mjs`, reusing `acceptance-1a.mjs`'s `browser()`, `totp()` and `assert()` helpers (copy them; this is a standalone script). Against a fresh install, it must:
1. Run setup with `preset: "coaching"`, then check that `GET /pipelines` shows the 8 Nupuur stages and `GET /fields` includes `struggles` and `handled_by`
2. Invite Riya as Sales and accept (as in 1A)
3. As the owner, create a lead for Riya with phone `050 123 4567`, and assert the owner sees `+971 50 123 4567`
4. As Riya, `GET /leads` returns only that lead, with the phone masked `+971 50 ••• ••67`
5. As Riya, reveal it: the full number comes back and `audit_log` has `lead.contact.reveal`
6. As Riya, move it to "Call booked": version 2, and the activity list shows `stage_changed`
7. As the owner, create a second lead owned by the owner; Riya's `GET /leads/:id` on it returns 404
8. As the owner, reassign Riya's lead to themselves; Riya's next `GET /leads/:id` returns 404 and her list is empty
9. As the owner, disable Riya; her session is dead (401)

It ends with `acceptance 1B passed`. Run it exactly as in 1A (toolbox, host network, `SETUP_TOKEN` from the API log) after truncating the identity **and** lead/config data. Truncate this list **as the postgres superuser**, since FORCE RLS doesn't affect TRUNCATE by the superuser: `settings, users, roles, role_permissions, user_roles, teams, team_members, sessions, recovery_codes, user_invites, password_resets, auth_throttle, idempotency_keys, reveal_counters, lead_contact_keys, activities, lead_assignment_history, lead_stage_history, lead_tags, leads, role_field_access, products, tags, lost_reasons, field_definitions, stages, pipelines`. Then restart the API.

- [ ] **Step 3: Record, reset, push**

Append a "Phase 1B" section to `docs/runbooks/acceptance.md` with the script output, the backup/restore-test results and the CI run URL. Truncate the same tables again so the real first-run setup happens in 1C, and restart the API. Then:
```bash
git add -A && git commit -m "docs: Phase 1B acceptance on the dev stack

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```
Update the `lume-progress` memory: 1B done, next Plan 1C (screens).
