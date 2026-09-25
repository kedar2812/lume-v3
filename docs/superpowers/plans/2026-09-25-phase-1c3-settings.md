# Phase 1C-3 — Settings Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins every Settings page the spec lists (Business, Pipeline & stages, Fields, Lost reasons, Tags, Products, People, Roles & access, Teams, My account, Audit log, About), plus the owner's one-currency rule: the business currency is changed only here, converting every amount at a live exchange rate the admin confirms.

**Architecture:** Most APIs exist from 1A/1B; Task 1–2 add the missing ones (invite list/resend/revoke, disable-with-reassign, currency quote and switch, About). The web side is a Settings shell (home cards chosen by permission, a section nav, one data hook that turns a mid-visit 403 into a calm "access changed" state) and one page per area, built from three shared pieces: `SettingsPage`, `ListEditor` (add, rename, reorder, archive) and the existing pickers.

**Tech Stack:** as 1C-1/1C-2 — Next.js 16 App Router, React 19, motion 12, Fastify 5 + Zod 4 + Drizzle, Postgres 17 with RLS, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-24-phase-1c-screens-design.md` §7 (Settings), §8 (quality bars). Owner decision 2026-09-25: one currency across LUME (memory `lume-one-currency`).

## Decision the owner confirms before Task 2

**Where live rates come from.** Recommended: **open.er-api.com** (ExchangeRate-API's open endpoint) — free, no key, 160+ currencies including AED, SAR, INR, updated once a day. The rate is shown with its timestamp and can be edited before confirming, so a bank's own rate can be used instead. A *real-time* (hourly or better) feed needs a paid key (e.g. Open Exchange Rates, ~USD 12/month); the plan's `RateSource` port takes either without other changes (`LUME_FX_PROVIDER=open-er-api|openexchangerates`, `LUME_FX_KEY`).

## Global Constraints

- Every push goes to `main`; the strict gate (fmt, lint, typecheck, all tests, web build) passes before every commit; CI is watched after every push.
- The build host `lumedev` is a client's live server: containers only, ports on 127.0.0.1, nothing installed on the host.
- The logo is the owner's file (`lume-mark.png`), never generated, resized or traced.
- Sounds only on achievements; settings actions are silent.
- Type sizes, tracking and weights only from the tokens in `styles/tokens.css` (`--fs-*`, `--ls-*`, `--fw-*`); never hand-set.
- One currency: amounts show the business currency as a fixed prefix (`MoneyInput`); no currency choice anywhere except the Business page.
- Web code imports `@lume/core/shared`, never the core root. No hand-written vendor-prefixed CSS.
- Every screen: axe clean in both themes; keyboard path for every action; `prefers-reduced-motion` honoured.
- Settings APIs refuse what the caller doesn't hold, and the page says so in plain words (spec §7 "refuses gracefully when access is lost mid-visit").

## Review Focus

1. **Access removed while a page is open** (a role edited by another admin): the next save or load gets 403 — the page must show "Your access to this page changed" with a way home, never a raw error or a half-saved form. (Task 3: `useSettingsResource` test.)
2. **Currency switched twice quickly, or with a stale quote:** two admins, or a double click, must never convert amounts twice. (Task 2: the switch carries the currency it expects to convert *from*; a mismatch is a 409.)
3. **Archiving a stage that still has leads:** the page must ask where they go and refuse to archive into another pipeline's stage or into the stage itself. (Task 5 test.)
4. **Editing a field's options:** renaming an option must keep its id, so every lead's value survives; removing an option in use archives it instead. (Task 6 test.)
5. **Disabling the last owner or yourself, or granting what you don't hold:** refused with the reason, not a silent no-op. (Task 8 and Task 9 tests.)

---

## File map

API
- `apps/api/src/modules/invites/{routes,service}.ts` — list pending, resend, revoke.
- `apps/api/src/modules/users/{routes,service}.ts` — disable takes `reassignTo`.
- `apps/api/src/money/rates.ts` (new) — `RateSource` port, `openErApi`, `openExchangeRates`, `fakeRates` for tests.
- `apps/api/src/modules/settings/{routes,service}.ts` — `GET /settings/currency/quote`, `POST /settings/currency`; `PATCH /settings` refuses `currency`.
- `apps/api/src/modules/about/routes.ts` (new) — `GET /api/v1/about`.
- `packages/db/migrations/0012_currency_switch.sql` (new) — `convert_amounts()` (SECURITY DEFINER), SELECT on `ops_restore_tests` for `lume_app`.
- `packages/config/src/schema.ts` — `LUME_FX_PROVIDER`, `LUME_FX_KEY`, `LUME_VERSION`.

Web
- `apps/web/src/app/(app)/settings/layout.tsx` (new), `page.tsx` (home), and one folder per page: `business`, `pipeline`, `fields`, `lists` (lost reasons, tags, products), `people`, `roles`, `teams`, `account`, `audit`, `about`.
- `apps/web/src/components/settings/` (new): `SettingsNav.tsx`, `SettingsHome.tsx`, `SettingsPage.tsx`, `useSettingsResource.ts`, `ListEditor.tsx`, `AccessChanged.tsx`, `settings.module.css`, and one component per page (`BusinessForm.tsx`, `CurrencySwitch.tsx`, `PipelineEditor.tsx`, `FieldsEditor.tsx`, `FieldPreview.tsx`, `PeopleAdmin.tsx`, `RoleMatrix.tsx`, `FieldAccess.tsx`, `TeamsAdmin.tsx`, `MyAccount.tsx`, `AuditLog.tsx`, `About.tsx`).
- `apps/web/src/lib/settings/client.ts` (new) — typed calls for every settings endpoint.

Tests: beside each file (`*.test.ts(x)`), plus `apps/web/e2e/settings.spec.ts`, additions to `a11y.spec.ts`, `visual.spec.ts`, and `apps/web/e2e-live/acceptance-1c3.mjs`.

---

### Task 1: API — invites you can see, resend and revoke; disabling someone hands their leads over

**Files:**
- Modify: `apps/api/src/modules/invites/routes.ts`, `service.ts`; `apps/api/src/modules/users/routes.ts`, `service.ts`
- Test: `apps/api/src/modules/invites/invites.test.ts`, `apps/api/src/modules/users/users.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/v1/invites` (`users.manage`) → `{ invites: { id, email, name, roles: {id,name}[], invitedBy: string|null, expiresAt, expired: boolean }[] }` — open invites only (not accepted, not revoked).
  - `POST /api/v1/invites/:id/resend` → 204; revokes the old link, sends a fresh one (same email, name, roles), audit `invite.resent`.
  - `DELETE /api/v1/invites/:id` → 204; sets `revokedAt`, audit `invite.revoked`.
  - `POST /api/v1/users/:id/disable` body `{ reassignTo?: uuid | null }` → 204; leads owned by the user move to `reassignTo` (or become unassigned when `null`); omitted keeps them. Refuses: self (`SELF`), the last active owner (`LAST_OWNER`), a `reassignTo` that isn't an active user (`UNKNOWN_USER`).

- [ ] **Step 1: Write the failing tests**

In `invites.test.ts`:
```ts
it("lists open invites, resends one with a fresh link, and revokes another", async () => {
  const a = await admin.inject({ method: "POST", url: "/api/v1/invites", payload: { email: "a@x.test", name: "A", roleIds: [] } });
  const b = await admin.inject({ method: "POST", url: "/api/v1/invites", payload: { email: "b@x.test", name: "B", roleIds: [] } });
  expect(a.statusCode).toBe(201);
  expect(b.statusCode).toBe(201);
  const list = (await admin.inject({ method: "GET", url: "/api/v1/invites" })).json().invites;
  expect(list.map((i: { email: string }) => i.email).sort()).toEqual(["a@x.test", "b@x.test"]);
  const first = list.find((i: { email: string }) => i.email === "a@x.test");
  const before = h.mail.sent.length;
  expect((await admin.inject({ method: "POST", url: `/api/v1/invites/${first.id}/resend` })).statusCode).toBe(204);
  expect(h.mail.sent.length).toBe(before + 1);
  const second = list.find((i: { email: string }) => i.email === "b@x.test");
  expect((await admin.inject({ method: "DELETE", url: `/api/v1/invites/${second.id}` })).statusCode).toBe(204);
  const after = (await admin.inject({ method: "GET", url: "/api/v1/invites" })).json().invites;
  expect(after.map((i: { email: string }) => i.email)).toEqual(["a@x.test"]);
});

it("keeps invite management to people who manage users", async () => {
  const rep = await h.signIn(await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] }));
  expect((await rep.inject({ method: "GET", url: "/api/v1/invites" })).statusCode).toBe(403);
});
```
In `users.test.ts`:
```ts
it("disabling someone can hand their leads to a colleague or leave them unassigned", async () => {
  const leaving = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] });
  const taking = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] });
  const one = await h.seedLead({ ownerId: leaving.id });
  const two = await h.seedLead({ ownerId: leaving.id });
  const r = await admin.inject({ method: "POST", url: `/api/v1/users/${leaving.id}/disable`, payload: { reassignTo: taking.id } });
  expect(r.statusCode).toBe(204);
  for (const id of [one, two])
    expect((await admin.inject({ method: "GET", url: `/api/v1/leads/${id}` })).json().lead.ownerId).toBe(taking.id);
});

it("refuses to disable yourself, the last owner, or to hand leads to someone who can't take them", async () => {
  const me = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  const c = await h.signIn(me);
  expect((await c.inject({ method: "POST", url: `/api/v1/users/${me.id}/disable`, payload: {} })).json().error.code).toBe("SELF");
  const target = await h.seedUser({ grants: [] });
  const bad = await c.inject({ method: "POST", url: `/api/v1/users/${target.id}/disable`, payload: { reassignTo: "0190e0c0-0000-7000-8000-00000000dead" } });
  expect(bad.json().error.code).toBe("UNKNOWN_USER");
  const owner = (await h.pool.query<{ id: string }>("SELECT id FROM users WHERE is_owner LIMIT 1")).rows[0];
  if (owner) expect((await c.inject({ method: "POST", url: `/api/v1/users/${owner.id}/disable`, payload: {} })).json().error.code).toBe("LAST_OWNER");
});
```

- [ ] **Step 2: Run to verify they fail**
Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/api/src/modules/invites apps/api/src/modules/users'`
Expected: FAIL (404 on the new routes; the leads keep their owner).

- [ ] **Step 3: Implement**
- `invites/service.ts`: `listInvites(req)` selects open invites (`acceptedAt IS NULL AND revokedAt IS NULL`), joins role names and the inviter's name, and marks `expired: expiresAt < now`. `resendInvite(req, d, id)` loads the open invite (404 `INVITE_NOT_FOUND` otherwise) and calls `createInvite(req, d, { email, name, roleIds })` — which already revokes the open link and mails a fresh one — then audits `invite.resent`. `revokeInvite(req, id)` sets `revokedAt = now()` on the open invite, audits `invite.revoked`.
- `invites/routes.ts`: the three routes with `config: { permission: "users.manage" }` and `params: z.object({ id: z.uuid() })`.
- `users/service.ts` `setDisabled(req, d, id, disabled, reassignTo?)`: after the existing self check, when disabling an owner count active owners (`is_owner AND status='active'`) and refuse `LAST_OWNER` at one; when `reassignTo !== undefined` and not null, require an active user (`UNKNOWN_USER`); then in the same transaction `UPDATE leads SET owner_id = $reassignTo, version = version + 1 WHERE owner_id = $id AND deleted_at IS NULL` through `withAllScope` semantics (the same `set_config('lume.handoff_lead', …)` path `assignLead` uses is per lead; here use a `SECURITY DEFINER` function `reassign_all_leads(from uuid, to uuid)` added to `0012` so RLS scope of the caller doesn't hide leads), write one `lead_assignment_history` row per lead with `reason='owner_disabled'`, and audit `user.disabled` with `{ reassignedTo, leads: n }`.
- `users/routes.ts`: disable body `z.object({ reassignTo: z.uuid().nullable().optional() })`.

- [ ] **Step 4: Run to verify they pass** (same command). Expected: PASS.
- [ ] **Step 5: Gate, commit, push** — `feat(api): open invites listed, resent and revoked; disabling someone hands their leads over`.

---

### Task 2: API — one currency, switched only with a confirmed live rate; About

**Files:**
- Create: `apps/api/src/money/rates.ts`, `apps/api/src/money/rates.test.ts`, `apps/api/src/modules/about/routes.ts`, `apps/api/src/modules/about/about.test.ts`, `packages/db/migrations/0012_currency_switch.sql`
- Modify: `apps/api/src/modules/settings/{routes,service}.ts`, `apps/api/src/deps.ts` (add `rates: RateSource`), `apps/api/src/app.ts` (register about routes), `packages/config/src/schema.ts`, `apps/api/test/harness.ts` (inject `fakeRates`)
- Test: `apps/api/src/http/currency.test.ts` (extend)

**Interfaces:**
- Produces:
  - `type RateSource = { quote(from: string, to: string): Promise<{ rate: number; asOf: string; source: string }> }`; `openErApi(fetchImpl?)`, `openExchangeRates(key, fetchImpl?)`, `fakeRates(table: Record<string, number>)`.
  - `GET /api/v1/settings/currency/quote?to=USD` (`settings.manage`) → `{ from, to, rate, asOf, source, affected: { leads: number; products: number; customFields: number } }`. Refuses the current currency (`SAME_CURRENCY`) and unknown codes (400). A provider failure → 502 `RATES_UNAVAILABLE` with "Enter the rate yourself".
  - `POST /api/v1/settings/currency` body `{ from: string, to: string, rate: number }` (rate > 0, ≤ 1e6) → `{ currency, converted: { leads, products } }`. `from` must equal the current currency, else 409 `CURRENCY_CHANGED` (so a double click or a second admin never converts twice). Converts `leads.value`, `products.default_value` and every custom field of type `currency`, rounded to 2 decimals, bumps lead versions, audits `settings.currency.changed` with `{ from, to, rate, counts }`.
  - `PATCH /api/v1/settings` with `currency` → 400 `USE_DEDICATED_ENDPOINT`.
  - `GET /api/v1/about` (`auth.self`) → `{ version: string, lastRestoreTest: { finishedAt: string, ok: boolean, backup: string | null } | null }`.

- [ ] **Step 1: Write the failing tests**

`rates.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { openErApi } from "./rates";

describe("openErApi", () => {
  it("reads one rate and its date from the provider's answer", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ result: "success", time_last_update_utc: "Thu, 25 Sep 2026 00:02:31 +0000", rates: { USD: 0.2723 } })),
    );
    expect(await openErApi(fetchImpl as unknown as typeof fetch).quote("AED", "USD")).toEqual({
      rate: 0.2723, asOf: "2026-09-25T00:02:31.000Z", source: "open.er-api.com",
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://open.er-api.com/v6/latest/AED", expect.anything());
  });

  it("fails plainly when the provider has no rate", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: "error" }), { status: 200 }));
    await expect(openErApi(fetchImpl as unknown as typeof fetch).quote("AED", "USD")).rejects.toThrow("no rate");
  });
});
```
Extend `currency.test.ts` (the harness is built with `rates: fakeRates({ "AED:USD": 0.27 })`):
```ts
it("quotes a switch with what it will touch, and converts every amount once at the confirmed rate", async () => {
  await admin.inject({ method: "POST", url: "/api/v1/leads", payload: { name: "Money", value: 1000 } });
  const q = (await admin.inject({ method: "GET", url: "/api/v1/settings/currency/quote?to=USD" })).json();
  expect(q).toMatchObject({ from: "AED", to: "USD", rate: 0.27, source: "test" });
  expect(q.affected.leads).toBeGreaterThanOrEqual(1);
  const sw = await admin.inject({ method: "POST", url: "/api/v1/settings/currency", payload: { from: "AED", to: "USD", rate: 0.27 } });
  expect(sw.statusCode).toBe(200);
  const again = await admin.inject({ method: "POST", url: "/api/v1/settings/currency", payload: { from: "AED", to: "USD", rate: 0.27 } });
  expect(again.statusCode).toBe(409);
  expect(again.json().error.code).toBe("CURRENCY_CHANGED");
  const leads = (await admin.inject({ method: "GET", url: "/api/v1/leads?q=Money" })).json().items;
  expect(leads[0].value).toBe(270);
  expect((await admin.inject({ method: "GET", url: "/api/v1/settings" })).json().currency).toBe("USD");
});

it("changes the currency only through the switch", async () => {
  const r = await admin.inject({ method: "PATCH", url: "/api/v1/settings", payload: { currency: "EUR" } });
  expect(r.json().error.code).toBe("USE_DEDICATED_ENDPOINT");
});
```
`about.test.ts`:
```ts
it("tells anyone signed in the version and how the last restore test went", async () => {
  await h.ownerPool.query(
    "INSERT INTO ops_restore_tests (started_at, finished_at, backup_name, ok, details) VALUES (now(), now(), 'lume-20260922T0200Z.dump.age', true, '{}')",
  );
  const rep = await h.signIn(await h.seedUser({ grants: [] }));
  const about = (await rep.inject({ method: "GET", url: "/api/v1/about" })).json();
  expect(about.version).toMatch(/\S/);
  expect(about.lastRestoreTest).toMatchObject({ ok: true, backup: "lume-20260922T0200Z.dump.age" });
});
```

- [ ] **Step 2: Run to verify they fail**
Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/api/src/money apps/api/src/http/currency.test.ts apps/api/src/modules/about'`
Expected: FAIL (module not found; 404s).

- [ ] **Step 3: Implement**
`0012_currency_switch.sql`:
```sql
-- The business currency changes for everyone at once, whatever the admin's own lead scope: one
-- narrow, audited function does it, owned by the migration role, callable by the app.
CREATE FUNCTION convert_amounts(rate numeric, currency_keys text[])
RETURNS TABLE (leads integer, products integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE l integer; p integer; k text;
BEGIN
  UPDATE leads SET value = round(value * rate, 2), version = version + 1 WHERE value IS NOT NULL AND deleted_at IS NULL;
  GET DIAGNOSTICS l = ROW_COUNT;
  FOREACH k IN ARRAY currency_keys LOOP
    UPDATE leads SET custom = jsonb_set(custom, ARRAY[k], to_jsonb(round((custom->>k)::numeric * rate, 2)))
    WHERE custom ? k AND jsonb_typeof(custom->k) = 'number' AND deleted_at IS NULL;
  END LOOP;
  UPDATE products SET default_value = round(default_value * rate, 2) WHERE default_value IS NOT NULL;
  GET DIAGNOSTICS p = ROW_COUNT;
  RETURN QUERY SELECT l, p;
END $$;
REVOKE ALL ON FUNCTION convert_amounts(numeric, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION convert_amounts(numeric, text[]) TO lume_app;

CREATE FUNCTION reassign_all_leads(from_user uuid, to_user uuid)
RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE leads SET owner_id = to_user, version = version + 1
  WHERE owner_id = from_user AND deleted_at IS NULL RETURNING id
$$;
REVOKE ALL ON FUNCTION reassign_all_leads(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reassign_all_leads(uuid, uuid) TO lume_app;

GRANT SELECT ON ops_restore_tests TO lume_app;
```
`rates.ts` implements the three sources (`openErApi` GETs `https://open.er-api.com/v6/latest/${from}` with a 5 s `AbortSignal.timeout`, `openExchangeRates` GETs `https://openexchangerates.org/api/latest.json?app_id=${key}` and divides `rates[to] / rates[from]`, `fakeRates` returns `{ rate: table[`${from}:${to}`], asOf: "2026-09-25T00:00:00.000Z", source: "test" }`). `deps.ts` picks by `config.fx.provider`. `settings/service.ts`: `quoteCurrency(req, d, to)` and `switchCurrency(req, input)` — the latter inside the request transaction: `SELECT currency FROM settings FOR UPDATE`, compare to `input.from` (409), `SELECT convert_amounts($rate, $keys)` with the keys of `field_definitions` of type `currency`, `UPDATE settings SET currency`, audit, `bumpFieldDefs(req)`. The About route reads `SELECT finished_at, ok, backup_name FROM ops_restore_tests ORDER BY finished_at DESC LIMIT 1` and `config.version` (`LUME_VERSION`, default the API package version).

- [ ] **Step 4: Run to verify they pass** (same command, then `pnpm vitest run apps/api` for the whole API). Expected: PASS.
- [ ] **Step 5: Gate, commit, push** — `feat(api): one currency, switched only with a confirmed live rate and converted once; About`.

---

### Task 2b: The first-use agreement (added by the owner, 2026-09-25)

Before anyone uses LUME for the first time — owner, admin or rep — they read the licence agreement,
terms of service and privacy policy in one scrolling reader; **I agree** unlocks only at the end of the
text; **Decline and sign out** signs out. The documents live in `@lume/core` (`LEGAL_DOCUMENTS`,
`LEGAL_VERSION`, `LEGAL_DRAFT`); changing the version asks everyone again. Evidence of each acceptance
(who, version, time, address, browser) is appended to `legal_acceptances`; `/auth/me` reports
`agreement` and `flags.needsAgreement`; `POST /me/agreement` takes only the current version. The web
routes through `/agree` before `/welcome` (`firstRunStop`). Tests: core documents, API agreement,
`AgreementScreen`, `first-run`, e2e `legal.spec.ts`, axe and screenshots of `/agree`, and both live
walkthroughs. **The text is a plain-language draft for legal review** (`LEGAL_DRAFT` shows a banner).

---

### Task 3: Settings shell — home by permission, section nav, access that changes mid-visit

**Files:**
- Create: `apps/web/src/app/(app)/settings/layout.tsx`, `apps/web/src/components/settings/{SettingsNav,SettingsHome,SettingsPage,AccessChanged,ListEditor}.tsx`, `useSettingsResource.ts`, `settings.module.css`, `apps/web/src/lib/settings/{client,areas}.ts`
- Modify: `apps/web/src/app/(app)/settings/page.tsx`
- Test: `apps/web/src/lib/settings/areas.test.ts`, `apps/web/src/components/settings/{SettingsHome,useSettingsResource,ListEditor}.test.tsx`

**Interfaces:**
- Produces:
  - `SETTINGS_AREAS: { id: string; title: string; blurb: string; href: string; permission: PermissionKey; group: "workspace" | "people" | "you" }[]` and `areasFor(actor): typeof SETTINGS_AREAS` in `lib/settings/areas.ts`.
  - `useSettingsResource<T>(load: () => Promise<ApiResult<T>>)` → `{ data: T | null; state: "loading" | "ready" | "access-changed" | "error"; reload(): void; guard<R>(r: ApiResult<R>): r is Ok<R> }` — `guard` flips the page to `access-changed` on 403.
  - `<SettingsPage title description actions? children />`, `<AccessChanged />` ("Your access to this page changed", link to Settings home).
  - `<ListEditor items onAdd onRename onReorder onArchive itemLabel addLabel renderExtra? />` — keyboard reorder (Alt+↑/↓) and drag handle; archive asks inline.

- [ ] **Step 1: Write the failing tests**

`areas.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fakeSession } from "@/server/session";
import { areasFor } from "./areas";

describe("areasFor", () => {
  it("shows a sales rep only their own settings", () => {
    const rep = fakeSession({ permissions: [{ key: "leads.view", scope: "own" }] });
    expect(areasFor(rep.actor).map((a) => a.id)).toEqual(["account", "about"]);
  });
  it("shows an admin every area their permissions reach, in the home's order", () => {
    const admin = fakeSession({
      permissions: [
        { key: "settings.manage", scope: null }, { key: "pipelines.manage", scope: null },
        { key: "fields.manage", scope: null }, { key: "users.manage", scope: null },
        { key: "roles.manage", scope: null }, { key: "teams.manage", scope: null }, { key: "audit.view", scope: null },
      ],
    });
    expect(areasFor(admin.actor).map((a) => a.id)).toEqual([
      "business", "pipeline", "fields", "lists", "people", "roles", "teams", "audit", "account", "about",
    ]);
  });
});
```
`useSettingsResource.test.tsx`:
```tsx
it("turns a 403 mid-visit into a calm 'access changed' state", async () => {
  const load = vi.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, data: { name: "LUME" } })
    .mockResolvedValueOnce({ ok: false, status: 403, code: "FORBIDDEN", message: "no" });
  const { result } = renderHook(() => useSettingsResource(load));
  await waitFor(() => expect(result.current.state).toBe("ready"));
  act(() => result.current.reload());
  await waitFor(() => expect(result.current.state).toBe("access-changed"));
});
```
`ListEditor.test.tsx`:
```tsx
it("adds, renames, reorders from the keyboard and archives only after asking", async () => {
  const h = { onAdd: vi.fn(), onRename: vi.fn(), onReorder: vi.fn(), onArchive: vi.fn() };
  render(<ListEditor items={[{ id: "a", label: "Price" }, { id: "b", label: "Timing" }]} itemLabel="Reason" addLabel="Add a reason" {...h} />);
  await userEvent.type(screen.getByRole("textbox", { name: "New reason" }), "No budget{Enter}");
  expect(h.onAdd).toHaveBeenCalledWith("No budget");
  await userEvent.click(screen.getByRole("button", { name: "Rename Price" }));
  await userEvent.clear(screen.getByRole("textbox", { name: "Reason name" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Reason name" }), "Too expensive{Enter}");
  expect(h.onRename).toHaveBeenCalledWith("a", "Too expensive");
  screen.getByRole("button", { name: "Move Timing" }).focus();
  await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
  expect(h.onReorder).toHaveBeenCalledWith(["b", "a"]);
  await userEvent.click(screen.getByRole("button", { name: "Archive Timing" }));
  expect(h.onArchive).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Archive" }));
  expect(h.onArchive).toHaveBeenCalledWith("b");
});
```
`SettingsHome.test.tsx`: renders cards for `areasFor(session.actor)`, each a link named by its title with its blurb, and a rep sees exactly "My account" and "About".

- [ ] **Step 2: Run to verify they fail** — `scripts/dev.sh run bash -c 'pnpm vitest run apps/web/src/lib/settings apps/web/src/components/settings'`. Expected: FAIL, modules not found.
- [ ] **Step 3: Implement.** `layout.tsx` (server) calls `requireSession()` and renders `SettingsNav` (the areas as a vertical nav, current page marked `aria-current`, a narrow screen shows it as a select) beside `children`. Each page's server component calls `requirePermission(area.permission)` and passes initial data. `SettingsPage` gives the title (`--fs-3xl`), description (`--fs-md`, `--text-2`) and right-aligned actions. `ListEditor` rows: drag handle button "Move <label>" (pointer drag + Alt+↑/↓), label, "Rename <label>" pencil (inline editor, Enter saves, Escape cancels), optional extra slot, "Archive <label>" which swaps the row for "Archive <label>? Leads keep it; it just can't be picked any more." with **Archive**/**Cancel**. The home is `SettingsHome` grouped "Your workspace", "People and access", "You", with `ReplayTour` kept in My account.
- [ ] **Step 4: Run to verify they pass.** Expected: PASS.
- [ ] **Step 5: Gate, commit, push** — `feat(web): settings shell — home by permission, section nav, calm state when access changes mid-visit`.

---

### Task 4: Business page — name, timezone, country, week start, and the currency switch

**Files:**
- Create: `apps/web/src/app/(app)/settings/business/page.tsx`, `apps/web/src/components/settings/{BusinessForm,CurrencySwitch}.tsx` + tests
- Modify: `apps/web/src/lib/settings/client.ts`

**Interfaces:**
- Consumes: `CurrencyPicker`, `CountryPicker`, `TimezonePicker`, `Dialog`, `settingsClient.getSettings/patchSettings/quoteCurrency/switchCurrency`.
- Produces: `settingsClient.quoteCurrency(to)`, `settingsClient.switchCurrency({ from, to, rate })`.

- [ ] **Step 1: Write the failing tests** (`CurrencySwitch.test.tsx`):
```tsx
it("quotes the live rate, shows what changes, and converts only after the admin confirms", async () => {
  vi.mocked(settingsClient.quoteCurrency).mockResolvedValue({ ok: true, status: 200, data: {
    from: "AED", to: "USD", rate: 0.2723, asOf: "2026-09-25T00:02:31.000Z", source: "open.er-api.com",
    affected: { leads: 42, products: 3, customFields: 0 } } });
  vi.mocked(settingsClient.switchCurrency).mockResolvedValue({ ok: true, status: 200, data: { currency: "USD", converted: { leads: 42, products: 3 } } });
  const onSwitched = vi.fn();
  render(<CurrencySwitch current="AED" onSwitched={onSwitched} />);
  await userEvent.click(screen.getByRole("button", { name: "Change currency" }));
  await userEvent.click(screen.getByRole("button", { name: /^New currency/ }));
  await userEvent.type(screen.getByRole("combobox", { name: "Search currencies" }), "usd{Enter}");
  const dialog = await screen.findByRole("dialog", { name: "Change the currency to US Dollar?" });
  expect(dialog).toHaveTextContent("1 AED = 0.2723 USD");
  expect(dialog).toHaveTextContent("42 lead values and 3 package prices will be converted");
  expect(dialog).toHaveTextContent("open.er-api.com, 25 Sep 2026");
  expect(settingsClient.switchCurrency).not.toHaveBeenCalled();
  await userEvent.click(within(dialog).getByRole("button", { name: "Convert to USD" }));
  expect(settingsClient.switchCurrency).toHaveBeenCalledWith({ from: "AED", to: "USD", rate: 0.2723 });
  expect(onSwitched).toHaveBeenCalledWith("USD");
});

it("lets the admin type the rate when the live one isn't available", async () => {
  vi.mocked(settingsClient.quoteCurrency).mockResolvedValue({ ok: false, status: 502, code: "RATES_UNAVAILABLE", message: "x" });
  render(<CurrencySwitch current="AED" onSwitched={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Change currency" }));
  await userEvent.click(screen.getByRole("button", { name: /^New currency/ }));
  await userEvent.type(screen.getByRole("combobox", { name: "Search currencies" }), "usd{Enter}");
  expect(await screen.findByText(/live rate isn’t available/i)).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("1 AED in USD"), "0.27");
  await userEvent.click(screen.getByRole("button", { name: "Convert to USD" }));
  expect(settingsClient.switchCurrency).toHaveBeenCalledWith({ from: "AED", to: "USD", rate: 0.27 });
});
```
`BusinessForm.test.tsx`: saving name, timezone, country and week start sends one `patchSettings` with only the changed keys and shows "Saved" (no sound); a 403 shows `AccessChanged`.

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** The currency row shows the current currency (flag, name, code) and **Change currency**; the flow is a `Dialog`: pick the new currency, quote, then the confirmation with the rate (editable number field "1 AED in USD", prefilled), its source and date, the counts, and **Convert to USD** (danger-styled: it changes every amount). A 409 `CURRENCY_CHANGED` reloads and says "The currency was just changed by someone else." After success the page reloads the catalog (`router.refresh()`).
- [ ] **Step 4–5:** pass; gate, commit, push — `feat(web): Business settings, and a currency switch that converts at a confirmed live rate`.

---

### Task 5: Pipeline & stages

**Files:** Create `apps/web/src/app/(app)/settings/pipeline/page.tsx`, `apps/web/src/components/settings/PipelineEditor.tsx` + test.

**Interfaces:** Consumes existing `GET /pipelines`, `POST /pipelines/:id/stages`, `PUT /pipelines/:id/stage-order`, `PATCH /stages/:id` (`name`, `color`, `kind`, `requiredFieldIds`, `slaHours`), `POST /stages/:id/archive` (`moveToStageId`), `ListEditor`.

- [ ] **Step 1: Write the failing tests** (`PipelineEditor.test.tsx`):
```tsx
it("renames, recolours and reorders stages, and saves each change as it's made", async () => {
  render(<PipelineEditor pipelines={testCatalog().pipelines} fields={testCatalog().fields} />);
  await userEvent.click(screen.getByRole("button", { name: "Rename Message sent" }));
  await userEvent.clear(screen.getByRole("textbox", { name: "Stage name" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Stage name" }), "Messaged{Enter}");
  expect(pipelinesClient.patchStage).toHaveBeenCalledWith("s-sent", { name: "Messaged" });
  await userEvent.click(screen.getByRole("button", { name: "Colour for New" }));
  await userEvent.click(screen.getByRole("radio", { name: "Cyan" }));
  expect(pipelinesClient.patchStage).toHaveBeenCalledWith("s-new", { color: "cyan" });
});

it("asks where a stage's leads go before archiving it, offering only this pipeline's other open stages", async () => {
  render(<PipelineEditor pipelines={testCatalog().pipelines} fields={testCatalog().fields} />);
  await userEvent.click(screen.getByRole("button", { name: "Archive Call booked" }));
  const ask = screen.getByRole("dialog", { name: "Archive Call booked?" });
  const choices = within(ask).getAllByRole("radio").map((r) => r.getAttribute("aria-label"));
  expect(choices).toEqual(["New", "Message sent"]);
  await userEvent.click(within(ask).getByRole("radio", { name: "Message sent" }));
  await userEvent.click(within(ask).getByRole("button", { name: "Archive and move its leads" }));
  expect(pipelinesClient.archiveStage).toHaveBeenCalledWith("s-booked", "s-sent");
});

it("sets the fields a stage needs, from the lead's fields", async () => {
  render(<PipelineEditor pipelines={testCatalog().pipelines} fields={testCatalog().fields} />);
  await userEvent.click(screen.getByRole("button", { name: "Needs for Call booked" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "Struggles" }));
  expect(pipelinesClient.patchStage).toHaveBeenCalledWith("s-booked", { requiredFieldIds: ["f-struggles"] });
});
```
- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** A pipeline select (several pipelines), then `ListEditor` of stages with extras: colour swatch popover (the eight tokens as radios), kind badge (open / won / lost; a pipeline keeps at least one won and one lost — the API refuses otherwise and its message is shown), "Needs" popover (checkboxes of editable fields), SLA hours input. Reorder calls `PUT stage-order` with the whole order. Archive dialog: radios of this pipeline's other open stages (never itself, never won/lost), **Archive and move its leads**. "Add a stage" appends an open stage. Every change saves immediately, with a quiet inline "Saved" and undo for rename.
- [ ] **Step 4–5:** pass; gate, commit, push — `feat(web): pipeline & stages — rename, recolour, reorder, needs and SLA; archiving asks where its leads go`.

---

### Task 6: Fields — custom fields with a live preview of the lead form

**Files:** Create `apps/web/src/app/(app)/settings/fields/page.tsx`, `apps/web/src/components/settings/{FieldsEditor,FieldPreview}.tsx` + tests.

**Interfaces:** Consumes `GET /fields`, `POST /fields`, `PATCH /fields/:id`, `POST /fields/:id/archive`; `FieldEditor` (Task 1C-2) in `inForm` mode for the preview.

- [ ] **Step 1: Write the failing tests** (`FieldsEditor.test.tsx`):
```tsx
it("adds a select field and shows it in the lead form preview as it's being made", async () => {
  render(<FieldsEditor fields={testCatalog().fields} />);
  await userEvent.click(screen.getByRole("button", { name: "Add a field" }));
  await userEvent.type(screen.getByLabelText("Field name"), "Budget band");
  await userEvent.selectOptions(screen.getByLabelText("Type"), "select");
  await userEvent.type(screen.getByRole("textbox", { name: "New option" }), "Under 5k{Enter}");
  const preview = screen.getByRole("region", { name: "Lead form preview" });
  expect(within(preview).getByRole("combobox", { name: "Budget band" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Create field" }));
  expect(fieldsClient.create).toHaveBeenCalledWith(expect.objectContaining({ label: "Budget band", type: "select", options: [{ label: "Under 5k" }] }));
});

it("renaming an option keeps its id, so every lead's value survives", async () => {
  render(<FieldsEditor fields={testCatalog().fields} />);
  await userEvent.click(screen.getByRole("button", { name: "Edit Struggles" }));
  await userEvent.click(screen.getByRole("button", { name: "Rename Confidence" }));
  await userEvent.clear(screen.getByRole("textbox", { name: "Option name" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Option name" }), "Self-confidence{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "Save field" }));
  expect(fieldsClient.patch).toHaveBeenCalledWith("f-struggles", expect.objectContaining({
    options: expect.arrayContaining([expect.objectContaining({ id: "o1", label: "Self-confidence" })]),
  }));
});

it("refuses a type change with the reason, and archives instead of deleting", async () => {
  render(<FieldsEditor fields={testCatalog().fields} />);
  await userEvent.click(screen.getByRole("button", { name: "Edit Struggles" }));
  expect(screen.getByLabelText("Type")).toBeDisabled();
  expect(screen.getByText("A field’s type can’t change once leads use it. Make a new field instead.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Archive Struggles" })).toBeInTheDocument();
});
```
- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Left: the field list (core fields marked "Built in", not editable except label and required); right: the editor (name, type, required, options for select/multi_select via `ListEditor` whose items keep ids, help text), and below it `FieldPreview`, a `role="region"` labelled "Lead form preview" rendering every non-archived field (the draft included) with `FieldEditor inForm`. Currency-type fields show the business currency prefix.
- [ ] **Step 4–5:** pass; gate, commit, push — `feat(web): custom fields with a live lead-form preview; options keep their ids; archive, never delete`.

---

### Task 7: Lost reasons, Tags, Products

**Files:** Create `apps/web/src/app/(app)/settings/lists/page.tsx`, `apps/web/src/components/settings/Lists.tsx` + test.

**Interfaces:** Consumes the existing list endpoints (`/lost-reasons`, `/tags`, `/products`) and `ListEditor`; products use `MoneyInput` with the business currency.

- [ ] **Step 1: Write the failing test** (`Lists.test.tsx`):
```tsx
it("keeps three simple lists: reasons and tags by name, packages with a price in the business currency", async () => {
  render(<Lists catalog={testCatalog()} />);
  const packages = screen.getByRole("region", { name: "Packages" });
  await userEvent.click(within(packages).getByRole("button", { name: "Add a package" }));
  await userEvent.type(within(packages).getByLabelText("Package name"), "Starter");
  await userEvent.type(within(packages).getByLabelText("Price"), "1,500");
  expect(within(packages).getByText("AED")).toBeInTheDocument();
  await userEvent.click(within(packages).getByRole("button", { name: "Add" }));
  expect(listsClient.createProduct).toHaveBeenCalledWith({ name: "Starter", defaultValue: 1500 });
  const tags = screen.getByRole("region", { name: "Tags" });
  await userEvent.type(within(tags).getByRole("textbox", { name: "New tag" }), "VIP{Enter}");
  expect(listsClient.createTag).toHaveBeenCalledWith({ label: "VIP", color: expect.any(String) });
});
```
- [ ] **Step 2–5:** fail, implement (three `ListEditor` sections: Lost reasons with reorder; Tags with a colour swatch; Packages with price), pass, gate, commit — `feat(web): lost reasons, tags and packages`.

---

### Task 8: People and Teams

**Files:** Create `apps/web/src/app/(app)/settings/{people,teams}/page.tsx`, `apps/web/src/components/settings/{PeopleAdmin,TeamsAdmin}.tsx` + tests.

**Interfaces:** Consumes Task 1's invite and disable endpoints, `GET /users`, `PATCH /users/:id` (roles), `DELETE /users/:id/sessions`, `/teams*`, `GET /roles/assignable`.

- [ ] **Step 1: Write the failing tests** (`PeopleAdmin.test.tsx`):
```tsx
it("invites someone with a role, and lists open invites with resend and revoke", async () => {
  const invites = [{ id: "i1", email: "b@x.test", name: "Bilal", roles: [{ id: "r-sales", name: "Sales" }], invitedBy: "Nupuur Patil", expiresAt: "2026-10-02T00:00:00Z", expired: false }];
  render(<PeopleAdmin users={[]} invites={invites} roles={[{ id: "r-sales", name: "Sales" }]} session={admin()} />);
  await userEvent.type(screen.getByLabelText("Email"), "c@x.test");
  await userEvent.type(screen.getByLabelText("Name"), "Chen");
  await userEvent.selectOptions(screen.getByLabelText("Role"), "r-sales");
  await userEvent.click(screen.getByRole("button", { name: "Send invite" }));
  expect(invitesClient.create).toHaveBeenCalledWith({ email: "c@x.test", name: "Chen", roleIds: ["r-sales"] });
  await userEvent.click(screen.getByRole("button", { name: "Resend invite to b@x.test" }));
  expect(invitesClient.resend).toHaveBeenCalledWith("i1");
  await userEvent.click(screen.getByRole("button", { name: "Revoke invite to b@x.test" }));
  expect(invitesClient.revoke).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
  expect(invitesClient.revoke).toHaveBeenCalledWith("i1");
});

it("disabling someone asks what happens to their leads", async () => {
  render(<PeopleAdmin users={[{ id: "u-riya", name: "Riya Sharma", email: "r@x.test", status: "active", isOwner: false, twoFactor: true, lastLoginAt: null, roles: [] }, { id: "u-tas", name: "Tasneem Shaikh", email: "t@x.test", status: "active", isOwner: false, twoFactor: true, lastLoginAt: null, roles: [] }]} invites={[]} roles={[]} session={admin()} />);
  await userEvent.click(screen.getByRole("button", { name: "Disable Riya Sharma" }));
  const ask = screen.getByRole("dialog", { name: "Disable Riya Sharma?" });
  expect(ask).toHaveTextContent("Riya will be signed out everywhere");
  await userEvent.selectOptions(within(ask).getByLabelText("Riya’s leads go to"), "u-tas");
  await userEvent.click(within(ask).getByRole("button", { name: "Disable" }));
  expect(usersClient.disable).toHaveBeenCalledWith("u-riya", { reassignTo: "u-tas" });
});
```
(The copy uses the person's first name, never a guessed pronoun.)
`TeamsAdmin.test.tsx`:
```tsx
it("creates a team, sets its members and lead, and asks before deleting it", async () => {
  vi.mocked(teamsClient.create).mockResolvedValue({ ok: true, status: 201, data: { team: { id: "t1", name: "Dubai", members: [] } } });
  render(<TeamsAdmin teams={[]} people={testCatalog().people} />);
  await userEvent.type(screen.getByRole("textbox", { name: "New team" }), "Dubai{Enter}");
  expect(teamsClient.create).toHaveBeenCalledWith("Dubai");
  await userEvent.click(await screen.findByRole("checkbox", { name: "Riya Sharma in Dubai" }));
  await userEvent.click(screen.getByRole("radio", { name: "Riya Sharma leads Dubai" }));
  expect(teamsClient.setMembers).toHaveBeenLastCalledWith("t1", [{ userId: "u-riya", isLead: true }]);
  await userEvent.click(screen.getByRole("button", { name: "Delete Dubai" }));
  expect(teamsClient.remove).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Delete team" }));
  expect(teamsClient.remove).toHaveBeenCalledWith("t1");
});
```

- [ ] **Step 2–5:** fail, implement, pass, gate, commit — `feat(web): people (invite, resend, revoke, disable with a lead hand-off, end sessions) and teams`.

---

### Task 9: Roles & access — permission matrix with scopes, and per-field access

**Files:** Create `apps/web/src/app/(app)/settings/roles/page.tsx`, `apps/web/src/components/settings/{RoleMatrix,FieldAccess}.tsx` + tests.

**Interfaces:** Consumes `GET /permissions` (catalog), `GET/POST/PATCH /roles`, `POST /roles/:id/clone`, `DELETE /roles/:id` (with replacement), `PUT /roles/:id/field-access`.

- [ ] **Step 1: Write the failing tests** (`RoleMatrix.test.tsx`):
```tsx
it("grants a permission with a scope, and explains a refusal to grant what the editor doesn't hold", async () => {
  vi.mocked(rolesClient.patch).mockResolvedValueOnce({ ok: false, status: 403, code: "CANNOT_GRANT", message: "You can only grant permissions you hold yourself" });
  render(<RoleMatrix role={salesRole()} catalog={permissionCatalog()} />);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "View leads: scope" }), "team");
  expect(await screen.findByText("You can only grant permissions you hold yourself")).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "View leads: scope" })).toHaveDisplayValue("Own");
});
```
`FieldAccess.test.tsx`: each field row has Hidden / View / Edit radios per role; choosing Hidden for Phone on Sales calls `setFieldAccess("r-sales", { phone: "hidden" })`; the owner role's rows are read-only with "The owner always sees everything".

- [ ] **Step 2–5:** fail, implement (matrix grouped by area, each row a checkbox plus a scope select where the permission has scopes; a sticky summary "Sales can: see their own leads, …"; clone and delete with a replacement role picker), pass, gate, commit — `feat(web): roles & access — permission matrix with scopes, and per-field access`.

---

### Task 10: My account, Audit log, About

**Files:** Create `apps/web/src/app/(app)/settings/{account,audit,about}/page.tsx`, `apps/web/src/components/settings/{MyAccount,AuditLog,About}.tsx` + tests.

**Interfaces:** Consumes `GET /me/sessions`, `DELETE /me/sessions/:id`, `/me/2fa/*`, `POST /me/recovery-codes`, `GET /audit`, `GET /people`, `GET /about`, `ReplayTour`.

- [ ] **Step 1: Write the failing tests**
```tsx
it("lists my sessions with this one marked, and ends the others", async () => {
  vi.mocked(accountClient.sessions).mockResolvedValue({ ok: true, status: 200, data: { sessions: [
    { id: "s1", current: true, device: "Chrome · Windows", lastSeenAt: "2026-09-25T10:00:00Z" },
    { id: "s2", current: false, device: "Safari · iPhone", lastSeenAt: "2026-09-24T08:00:00Z" },
  ] } });
  render(<MyAccount session={fakeSession()} />);
  expect(await screen.findByText("This device")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "End session on Chrome · Windows" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "End session on Safari · iPhone" }));
  expect(accountClient.endSession).toHaveBeenCalledWith("s2");
});

it("regenerates recovery codes only after confirming, and shows them once", async () => {
  vi.mocked(accountClient.newRecoveryCodes).mockResolvedValue({ ok: true, status: 200, data: { codes: ["AAAA-BBBB", "CCCC-DDDD"] } });
  render(<MyAccount session={fakeSession()} />);
  await userEvent.click(await screen.findByRole("button", { name: "New recovery codes" }));
  expect(accountClient.newRecoveryCodes).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Replace my codes" }));
  expect(await screen.findByText("AAAA-BBBB")).toBeInTheDocument();
  expect(screen.getByText("The old codes stop working now.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "I’ve saved these" }));
  expect(screen.queryByText("AAAA-BBBB")).not.toBeInTheDocument();
});
it("reads the audit log in words, filters by person and action, and pages with the cursor", async () => {
  vi.mocked(auditClient.list).mockResolvedValueOnce({ ok: true, status: 200, data: { entries: [
    { id: 10, action: "lead.contact.reveal", actorUserId: "u-riya", entityType: "lead", entityId: "l1", createdAt: "2026-09-25T10:00:00Z", diff: null },
  ], nextCursor: 10 } });
  render(<AuditLog people={testCatalog().people} />);
  expect(await screen.findByText("Riya Sharma revealed a lead’s contact")).toBeInTheDocument();
  expect(screen.getByText("The audit log can’t be edited or deleted, by anyone.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Load earlier" }));
  expect(auditClient.list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 10 }));
});
it("About shows the version and the last restore test in plain words", async () => {
  vi.mocked(aboutClient.get)
    .mockResolvedValueOnce({ ok: true, status: 200, data: { version: "1.3.0", lastRestoreTest: { finishedAt: "2026-09-22T04:00:00Z", ok: true, backup: "lume-20260922T0200Z.dump.age" } } })
    .mockResolvedValueOnce({ ok: true, status: 200, data: { version: "1.3.0", lastRestoreTest: null } });
  const first = render(<About />);
  expect(await screen.findByText("Last restore test: passed, 22 Sep 2026")).toBeInTheDocument();
  expect(screen.getByText("Version 1.3.0")).toBeInTheDocument();
  first.unmount();
  render(<About />);
  expect(await screen.findByText("No restore test has run yet")).toBeInTheDocument();
});
```
- [ ] **Step 2–5:** fail, implement (an `auditPhrase(entry, people)` map in `lib/settings/audit.ts` with a unit test covering every action the API writes; unknown actions fall back to the raw action name), pass, gate, commit — `feat(web): my account, the audit log in words, and About`.

---

### Task 11: End to end, accessibility, screenshots and role snapshots

**Files:** Create `apps/web/e2e/settings.spec.ts`; modify `a11y.spec.ts`, `visual.spec.ts`.

- [ ] **Step 1: Write the specs** — spec §2's flows against the real stack:
```ts
test("@smoke rename a stage and see it on the board", …);
test("@smoke add a field and see it on the New lead form", …);
test("@smoke hide a field from Sales and it vanishes for Noor", …);  // stateFile("seller")
test("@smoke invite, then disable someone: their session dies and their leads move", …);
test("@smoke read the audit log", …);
test("switch the currency with a typed rate: every amount converts once", …); // the e2e API runs with LUME_FX_PROVIDER=fake
test("a page whose access is removed mid-visit says so", …); // remove settings.manage from the admin's role in a second context, then save
```
a11y: every settings route for the owner in both themes, plus the currency dialog open. visual: Settings home (owner, admin, seller) and Business, Pipeline, Fields, Roles pages in both themes; role snapshots of the Settings home for owner, admin and seller.
- [ ] **Step 2: Run** `scripts/dev.sh run bash -c 'cd apps/web && pnpm exec playwright test --update-snapshots=missing && pnpm exec playwright test'`; review every new image before accepting it; copy baselines back from the box (untracked files there are wiped on the next sync).
- [ ] **Step 3: Gate, commit, push, watch CI** — `test(web): settings end to end, accessibility, screenshots and role snapshots`.

---

### Task 12: Live acceptance, docs and memory

- [ ] **Step 1:** `apps/web/e2e-live/acceptance-1c3.mjs`, run after `acceptance-1c1.mjs` with `ACCEPT_STATE_DIR` as in 1C-2: rename a stage; add a field and see it on the lead form; hide a field from Sales and see it vanish for Riya; invite and disable a person (their session dies, their leads move); switch currency with the live rate from the box (the owner's chosen provider) and check one converted value; read the audit log; About shows the version. Screenshots to `docs/runbooks/screenshots-1c3/`. Then `scripts/dev.sh reset-db`.
- [ ] **Step 2:** A "Phase 1C-3" section in `docs/runbooks/acceptance.md` (checks, screenshots, counts, CI link, findings). Execution notes at the end of this plan.
- [ ] **Step 3:** Memory `lume-progress`: 1C-3 done; next Google Sheets intake.
- [ ] **Step 4:** Commit and push `docs: Phase 1C-3 acceptance on the dev stack`; watch CI to green.

---

## Self-review (2026-09-25)

**Spec coverage (§7):** Business (Task 4) · Pipeline & stages incl. required fields, SLA, archive-with-move (Task 5) · Fields incl. live preview, option ids kept, archive not delete, type change refused (Task 6) · Lost reasons, Tags, Products (Task 7) · People incl. invite/resend/revoke, disable/enable, end sessions, reassign on disable (Tasks 1, 8) · Roles & access incl. matrix with scopes, per-field access, refusal to grant beyond one's own (Task 9) · Teams (Task 8) · My sessions & 2FA incl. recovery codes and tour replay (Task 10) · Audit log, cursor-paged, filters, "cannot be edited" (Task 10) · About incl. restore-test status (Tasks 2, 10). Spec §2 acceptance flows: Task 11. "Refuses gracefully when access is lost mid-visit": Task 3 + Task 11. Owner decision on one currency: Tasks 2 and 4.

**Placeholder scan:** every test step carries its test code. Task 11's e2e specs are named with their flows; each follows the 1C-2 spec style (`callApi`, `stateFile`, `hydrated`) and is written in full at execution, step 1.

**Type consistency:** `settingsClient`, `pipelinesClient`, `fieldsClient`, `listsClient`, `usersClient`, `invitesClient`, `rolesClient`, `auditClient` are all created in `lib/settings/client.ts` in Task 3 and extended by later tasks. `RateSource` is defined once (Task 2) and consumed only by the settings service.
