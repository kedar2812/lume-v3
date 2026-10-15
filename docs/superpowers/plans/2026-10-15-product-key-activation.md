# Product Key Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A client enters the product key the owner issued on license.lumecrm.in at the very first step of setup; the licence server approves it and locks it to that one server; the owner manages keys (copy, rotate, release, hold-to-decommission) from the dashboard.

**Architecture:** One shared key format in `@lume/core` (canonical form, hashing input, display grouping). The licence server gains `POST /v1/activate`, install-bound check-ins, retired keys, and key actions; its panel gains the Ready-to-send card, the Licence key card and two bell items. The instance stores an install ID and its sealed key in `licence_state`, activates through the `LicenceKeeper`, exposes `POST /api/v1/setup/key` (hands the setup token to the browser that proved the key) and owner-only `POST /api/v1/licence/key`; the web shows the key step, the "your LUME is online" moment with the `online` chime, and Change key.

**Tech Stack:** TypeScript, Fastify + drizzle/pg (apps/api), Next.js 16 route handlers + raw pg (apps/licence), Next.js + motion/react (apps/web), Vitest, Playwright, Postgres 17.

**Spec:** `docs/superpowers/specs/2026-10-15-product-key-activation-design.md` (owner-approved; canvas https://claude.ai/artifact/2PhEkUtJvecyqdvFi5hyfn approved 2026-10-15).

## Global Constraints

- LUME is multi-client: no client names, sheet IDs or branding in code; fixtures fictional (`Harbour Clinic`, `Northwind Interiors`, `Coral Bay Physio` are fine).
- Copy speaks as LUME, never "we"; no founder promises; no guessed pronouns.
- Visual: Porcelain + Obsidian (Carbon), the one blue `#2A5BFF`; meetings never violet; full-window scrim for sheets; every screen flawless in Obsidian.
- Logos: `lume-mark.png` as-is; WhatsApp only from `apps/web/public/brand/whatsapp.svg` (official paths, `#25D366`, on a white tile on a `#0f7f44` button).
- Sound: achievements only. The new cue `online` is the only sound in setup.
- Motion: springs/curves as on the canvas; `prefers-reduced-motion` → cross-fade to the final frame.
- Key alphabet: Crockford base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`); key = `LUME-` + 5 groups of 4.
- Nothing about leads is ever sent to the licence server; the only new field sent is the random `installId`.
- Keys never in logs; audit shows last four only.
- Checks before every push: `pnpm lint` (on the box it stops at eslint on the untracked `social media/` folder, so ALSO run `pnpm exec prettier --check apps packages infra scripts` and `node scripts/check-client-names.mjs`), `pnpm typecheck`, full `pnpm exec vitest run`; then push main and watch CI.
- Never start a `dev.sh run` while another is running on the box; app.lumecrm.in stays untouched (Google review).

## Review Focus

1. **A key typed loosely** (lower case, spaces, no dashes, without `LUME`, `O` for `0`, `I`/`L` for `1`, a pasted en-dash) must activate the same licence as the issued spelling. Pinned in Task 1 and Task 3.
2. **Two activations at once** (double-click, two tabs, two servers racing) bind exactly once; the loser gets `KEY_IN_USE` or the same install's success, never two bindings or duplicate `activated` events. Pinned in Task 3.
3. **Licence server down during setup**: nothing is stored on the instance, no setup token is handed out, and the same key works when it's back. Pinned in Task 8 and Task 9.
4. **`.env` key and a stored key both present**: `.env` wins everywhere; Change key is refused with `KEY_FROM_ENV` and hidden in About. Pinned in Task 8 and Task 10.
5. **A rotated key used afterwards**: the bound server keeps getting the current licence for 7 days, then `KEY_DECOMMISSIONED`; any other server is refused at once. Pinned in Task 4.

---

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/licence/product-key.ts` (new) | canonical key, display grouping, completeness; `activateBody`; `checkBody` gains `installId` |
| `packages/core/src/shared.ts` | export the web-safe helpers |
| `apps/licence/migrations/0004_activation.sql` (new) | binding columns, `key_enc`, `released_at`, unique `key_hash`, `retired_keys` |
| `apps/licence/src/lib/keys.ts` | `hashKey` via the canonical form |
| `apps/licence/src/lib/seal.ts` (new) | AES-256-GCM seal/unseal with a purpose (moved out of `auth.ts`) |
| `apps/licence/src/server/activate.ts` + `src/app/v1/activate/route.ts` (new) | `POST /v1/activate` |
| `apps/licence/src/server/binding.ts` (new) | the one place that decides bind / same / other / retired for a licence and an install |
| `apps/licence/src/server/check.ts` | install-bound check-ins, retired keys |
| `apps/licence/src/server/clients.ts` | create stores `key_enc`; view gains activation; rotate/release/decommission-key/issue/reveal |
| `apps/licence/src/lib/alerts.ts` | two new alerts |
| `apps/licence/src/lib/message.ts` (new) | the client message text + WhatsApp link |
| `apps/licence/src/components/{NewLicence,ClientScreen,ClientsScreen,Bell,KeyCard,HoldButton}.tsx` | the panel |
| `packages/db/migrations/0065_licence_key.sql` (new), `packages/db/src/schema/licence.ts` | instance columns |
| `apps/api/src/licence/keeper.ts`, `options.ts`, `routes.ts` | credentials from env or DB, `activate()`, Change key |
| `apps/api/src/modules/setup/{routes,service}.ts` | `needsKey`, `POST /api/v1/setup/key` |
| `apps/web/src/lib/sound.ts` | the `online` cue |
| `apps/web/src/lib/setup-client.ts`, `components/setup/{SetupWizard,SetupScreen,KeyStep,OnlineMoment}.tsx` | the key step and the moment |
| `apps/web/src/components/licence/LicenceCard.tsx`, `lib/licence/client.ts` | Change key |
| `scripts/provision.sh`, `docs/runbooks/fleet.md`, `docs/runbooks/licence-server.md` | ops |

---

### Task 1: The key format in core

**Files:**
- Create: `packages/core/src/licence/product-key.ts`, test `packages/core/src/licence/product-key.test.ts`
- Modify: `packages/core/src/licence/index.ts`, `packages/core/src/licence/token.ts` (checkBody), `packages/core/src/shared.ts`, `packages/core/src/licence/licence.test.ts` (pinned body keys)

**Interfaces — Produces:**
- `KEY_GROUPS = 5`, `KEY_CHARS = 20`
- `keyChars(input: string): string` — up to 20 canonical characters (strips non-alphanumerics, upper-cases, drops a leading `LUME`, maps `O→0`, `I→1`, `L→1`, drops anything outside the alphabet)
- `canonicalKey(input: string): string | null` — `"LUME-XXXX-XXXX-XXXX-XXXX-XXXX"` when exactly 20 chars, else null
- `displayKey(input: string): string` — the partial grouped form for a field (`""` for nothing)
- `checkBody({...,installId})` adds `installId`; `activateBody({ licenseKey, installId, appVersion, now })` → `{ licenseKey, installId, appVersion, serverTime }`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/licence/product-key.test.ts
import { describe, expect, it } from "vitest";
import { canonicalKey, displayKey, keyChars } from "./product-key";
import { activateBody, checkBody } from "./token";

const ISSUED = "LUME-7K2P-Q9XD-4MRT-H8VC-7Q2K";

describe("the product key's one spelling", () => {
  it.each([
    ISSUED,
    "lume-7k2p-q9xd-4mrt-h8vc-7q2k",
    "7K2PQ9XD4MRTH8VC7Q2K",
    " LUME 7K2P Q9XD 4MRT H8VC 7Q2K ",
    "LUME–7K2P–Q9XD–4MRT–H8VC–7Q2K", // en-dashes from a chat app
  ])("%s → the issued key", (typed) => expect(canonicalKey(typed)).toBe(ISSUED));
  it("reads O as 0 and I or L as 1 (Crockford), never inventing a U", () => {
    expect(keyChars("LUME-O1IL")).toBe("0111");
    expect(keyChars("UUUU")).toBe("");
  });
  it("is null until all five groups are there, and never longer", () => {
    expect(canonicalKey("LUME-7K2P-Q9XD")).toBeNull();
    expect(canonicalKey(ISSUED + "ZZZZ")).toBe(ISSUED);
  });
  it("groups as the person types", () => {
    expect(displayKey("")).toBe("");
    expect(displayKey("7k2pq")).toBe("LUME-7K2P-Q");
    expect(displayKey(ISSUED)).toBe(ISSUED);
  });
});

describe("what goes to the licence server", () => {
  const now = new Date("2026-10-15T09:00:00Z");
  it("a check carries the install id and nothing about a lead", () => {
    expect(
      Object.keys(
        checkBody({ instanceId: "LUME-AAAA-BBBB", licenseKey: ISSUED, installId: "0190e0c0-0000-7000-8000-000000000001", appVersion: "1.4.2", activeUserCount: 3, leadCount: 9, now }),
      ).sort(),
    ).toEqual(["activeUserCount", "appVersion", "installId", "instanceId", "leadCount", "licenseKey", "serverTime"]);
  });
  it("an activation carries the key, the install id, the version and the clock, only", () => {
    expect(activateBody({ licenseKey: ISSUED, installId: "0190e0c0-0000-7000-8000-000000000001", appVersion: "1.4.2", now })).toEqual({
      licenseKey: ISSUED,
      installId: "0190e0c0-0000-7000-8000-000000000001",
      appVersion: "1.4.2",
      serverTime: "2026-10-15T09:00:00.000Z",
    });
  });
});
```

- [ ] **Step 2: Run** `bash scripts/dev.sh run pnpm exec vitest run packages/core/src/licence` — expected FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// packages/core/src/licence/product-key.ts
/**
 * A LUME product key (spec 2026-10-15 §1.1): LUME and five groups of four in Crockford's base32. Typed any way
 * (any case, spaces, dashes of any kind, with or without LUME, O for 0, I or L for 1) it has one spelling, so
 * the licence server's hash and the field's grouping agree.
 */
export const KEY_GROUPS = 5;
export const KEY_CHARS = KEY_GROUPS * 4;
const ALPHABET = /[0-9A-HJKMNP-TV-Z]/;
const READ_AS: Record<string, string> = { O: "0", I: "1", L: "1" };

/** Up to 20 key characters from whatever was typed. */
export function keyChars(input: string): string {
  let s = String(input).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.startsWith("LUME")) s = s.slice(4);
  let out = "";
  for (const ch of s) {
    const c = READ_AS[ch] ?? ch;
    if (ALPHABET.test(c)) out += c;
    if (out.length === KEY_CHARS) break;
  }
  return out;
}

const grouped = (chars: string) => (chars ? `LUME-${chars.match(/.{1,4}/g)!.join("-")}` : "");

/** The issued spelling, once all five groups are there; else null. */
export function canonicalKey(input: string): string | null {
  const c = keyChars(input);
  return c.length === KEY_CHARS ? grouped(c) : null;
}

/** What the field shows while someone types: grouped as far as it goes. */
export const displayKey = (input: string): string => grouped(keyChars(input));
```

In `token.ts`, `checkBody` takes `installId: string` and returns it between `licenseKey` and `appVersion`; add:

```ts
/** What an instance sends to activate a key (spec 2026-10-15 §2.1): only this. */
export function activateBody(o: { licenseKey: string; installId: string; appVersion: string; now: Date }) {
  return { licenseKey: o.licenseKey, installId: o.installId, appVersion: o.appVersion, serverTime: o.now.toISOString() };
}
```

`index.ts`: `export * from "./product-key";`. `shared.ts`: export `canonicalKey`, `displayKey`, `keyChars`, `KEY_CHARS` (pure, no node imports). `installId` is REQUIRED in `checkBody`, so the compiler lists its two callers: `apps/api/src/licence/keeper.ts` (the column arrives in Task 8's migration; until then it passes `installId: NO_INSTALL_YET`, a `const` uuid of zeros defined in keeper.ts with a one-line comment, and Task 8 deletes it and passes the real id — nothing ships between the two) and `apps/licence/src/server/check.test.ts` (Task 4 passes a uuid).

- [ ] **Step 4: Run** the same tests — PASS; `pnpm typecheck` — PASS after the two caller edits above.

- [ ] **Step 5: Commit** `feat(core): one spelling for a product key, and the install id in what's sent`.

---

### Task 2: Licence server schema, sealed keys, and the activation view

**Files:**
- Create: `apps/licence/migrations/0004_activation.sql`, `apps/licence/src/lib/seal.ts`, `apps/licence/src/lib/seal.test.ts`
- Modify: `apps/licence/src/lib/keys.ts` (hash via canonical), `apps/licence/src/server/auth.ts` (use `lib/seal`), `apps/licence/src/server/clients.ts` (create stores `key_enc`; `Row`/`view` gain activation; `revealKey`), `apps/licence/src/server/api.ts` (`GET /api/clients/:id/key`), `apps/licence/src/server/testing.ts` (seed `key_enc`, `install_id` options), tests in `clients.test.ts`

**Interfaces — Produces:**
- `seal(master: Buffer, plain: string, purpose: string): Buffer`, `unseal(master, blob, purpose): string`
- purpose strings: `totp:<adminId>` (unchanged), `key:<clientId>`
- `ClientView` gains `activation: { status: "not_activated" | "active" | "released" | "decommissioned"; ip: string | null; at: string | null; installId: string | null }` and `keyShowable: boolean`
- `revealKey(ctx, id) → { licenseKey: string }` (404 `NOT_SHOWABLE` when no `key_enc` or decommissioned)

- [ ] **Step 1: Migration**

```sql
-- apps/licence/migrations/0004_activation.sql
-- Product key activation (spec 2026-10-15 §2): a key is bound to the one install that activated it, kept sealed so
-- the owner can copy it again, and a retired key (rotated or decommissioned) never works anywhere again.
ALTER TABLE licences
  ADD COLUMN key_enc bytea,
  ADD COLUMN install_id uuid,
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN activated_ip text,
  ADD COLUMN released_at timestamptz,
  -- Decommissioned (held on the card): no live key until "Issue a new key".
  ADD COLUMN key_dead_at timestamptz;
CREATE UNIQUE INDEX licences_key_hash ON licences (key_hash);

CREATE TABLE retired_keys (
  key_hash bytea PRIMARY KEY CHECK (length(key_hash) = 32),
  client_id uuid NOT NULL REFERENCES clients ON DELETE CASCADE,
  key_last4 text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('rotated', 'decommissioned')),
  retired_at timestamptz NOT NULL,
  -- The install that held it when it was retired (a rotated key keeps working there for 7 days).
  install_id uuid
);
CREATE INDEX retired_keys_client ON retired_keys (client_id, retired_at DESC);
```

- [ ] **Step 2: Failing tests** (`seal.test.ts`: round trip; wrong purpose throws; `clients.test.ts`: a created licence's `revealKey` returns the key shown at creation; `view(...).activation.status` is `not_activated` for a new licence, `active` with ip/at after setting `install_id`/`activated_at`/`activated_ip`, `released` when `released_at` set and `install_id` null, `decommissioned` when `key_dead_at` set; `hashKey("lume 7k2p…")` equals `hashKey(issued)`).

- [ ] **Step 3: Implement.** `lib/seal.ts` holds the two functions from `auth.ts` with the AAD `purpose`; `auth.ts` imports them with `` `totp:${adminId}` `` (byte-identical AAD, so existing secrets still open). `keys.ts`: `const normal = (key: string) => canonicalKey(key) ?? key.trim().toUpperCase();` (import from `@lume/core`). `createClient` inserts `key_enc = seal(ctx.master, licenseKey, \`key:${cid}\`)`. `CLIENTS_SQL` selects `l.install_id, l.activated_at, l.activated_ip, l.released_at, l.key_dead_at, l.key_enc IS NOT NULL AS key_showable`; `view()` derives `activation`:

```ts
const activation = {
  status: r.key_dead_at ? "decommissioned" : r.install_id ? "active" : r.released_at ? "released" : "not_activated",
  ip: r.activated_ip, at: r.activated_at?.toISOString() ?? null, installId: r.install_id,
} as const;
```

`revealKey` unseals `key_enc` (refuses when `key_dead_at` or no `key_enc`); route `GET /api/clients/:id/key`.

- [ ] **Step 4: Run** `vitest run apps/licence/src` — PASS. **Step 5: Commit** `feat(licence): keys sealed for copying again, and each licence's activation`.

---

### Task 3: `POST /v1/activate`

**Files:**
- Create: `apps/licence/src/server/binding.ts`, `apps/licence/src/server/activate.ts`, `apps/licence/src/app/v1/activate/route.ts`, test `apps/licence/src/server/activate.test.ts`
- Modify: `apps/licence/src/server/context.ts` (limiter `activateIp`: 30/hour), `apps/licence/src/server/check.ts` (export `record`, `limited` for reuse)

**Interfaces — Produces:**
- `findByKey(c: pg.PoolClient, key: string): Promise<LicenceRow | RetiredRow | null>` — looks up `licences` then `retired_keys` by `hashKey(key)` with `timingSafeEqual` on the found hash
- `bindOutcome(l, installId): "bind" | "same" | "other"`
- `handleActivate(req: Request, ctx: Ctx): Promise<Response>`
- Answers: 200 `{ instanceId, token }`; 401 `UNAUTHORIZED`; 403 `LICENCE_PAUSED`; 403 `KEY_DECOMMISSIONED`; 409 `KEY_IN_USE`; 429 with `retry-after`; 400 `BAD_REQUEST`

- [ ] **Step 1: Failing tests** (`activate.test.ts`, same harness as `check.test.ts`):

```ts
it("binds a new licence to the first install, answers a token it verifies, and records it", async () => {
  const c = await seedClient(t.pool, { type: "subscription", paidUntil: "2026-12-01" });
  const r = await post({ licenseKey: c.licenseKey.toLowerCase().replaceAll("-", " "), installId: A, appVersion: "1.5.0", serverTime: now.toISOString() });
  expect(r.status).toBe(200);
  const { instanceId, token } = await r.json();
  expect(instanceId).toBe(c.instanceId);
  expect(verifyLicence(token, KEYS, c.instanceId)?.state).toBe("active");
  expect(await q("SELECT install_id, activated_ip FROM licences WHERE client_id = $1", [c.clientId])).toEqual([{ install_id: A, activated_ip: "203.0.113.9" }]);
  expect((await q("SELECT kind FROM events WHERE client_id = $1 ORDER BY id", [c.clientId])).map((e) => e.kind)).toContain("activated");
});
it("answers the same install again (a closed tab), without a second event", …);
it("refuses another install with KEY_IN_USE, says nothing about the first, and records the attempt", …); // event activation_refused {ip}
it("two installs racing: exactly one binds", async () => { /* Promise.all of two posts with different installIds → statuses sorted [200, 409]; one `activated` event */ });
it("a paused or decommissioned client: LICENCE_PAUSED", …);
it("a retired key (rotated or decommissioned): KEY_DECOMMISSIONED, never 401", …);
it("an unknown key: 401 with nothing more, and wrong guesses are limited per address", …);
it("a released licence binds to the next install that activates", …);
it("rejects any field it doesn't expect (nothing about leads gets in)", …); // body with leadCount → 400
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement.** `activate.ts` mirrors `handleCheck`'s structure (IP limit → capped JSON → strict zod `{ licenseKey: max128, installId: z.uuid(), appVersion: 1..40, serverTime: iso }` → wrong-key limiter keyed `ip` → transaction:

```ts
await c.query("BEGIN");
const hit = await findByKey(c, b.licenseKey);          // SELECT … FOR UPDATE on licences
if (!hit) → ROLLBACK, wrongKey.take(ip), 401
if (hit.kind === "retired") → ROLLBACK, 403 KEY_DECOMMISSIONED
if (hit.decommissioned || hit.suspended || hit.keyDead) → 403 LICENCE_PAUSED   // keyDead can't happen (key moves to retired_keys) — kept for safety
switch (bindOutcome(hit, b.installId)) {
  case "other": event activation_refused {ip}; COMMIT; 409 KEY_IN_USE
  case "bind": UPDATE licences SET install_id=$2, activated_at=$3, activated_ip=$4, released_at=NULL; event activated {ip, version}
  case "same": nothing to write
}
COMMIT; then record(...) the check-in exactly as /v1/check does; issueToken(...) → 200 { instanceId, token }
```

`binding.ts`:

```ts
/** Which way an activation goes for this licence and this install (spec §2.1, §2.4). */
export function bindOutcome(l: { install_id: string | null }, installId: string): "bind" | "same" | "other" {
  if (!l.install_id) return "bind";
  return l.install_id === installId ? "same" : "other";
}
```

`route.ts`: `export const POST = (req: Request) => handleActivate(req, context());` with `export const dynamic = "force-dynamic"` as `app/v1/check/route.ts` does.

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat(licence): /v1/activate — a key binds to the first install that enters it`.

---

### Task 4: Install-bound check-ins and retired keys

**Files:** Modify `apps/licence/src/server/check.ts`, `apps/licence/src/server/check.test.ts`

**Interfaces — Consumes:** `findByKey`, `bindOutcome` (Task 3). **Produces:** `/v1/check` body requires `installId`.

Rules (spec §2.2, §2.4):
- Look the key up by **instance id + key** as today; if no match, try `retired_keys` for this key:
  - `rotated`, same `install_id` as recorded, `retired_at` within 7 days → answer as the current licence (the client hasn't entered the new key yet);
  - `rotated` older than 7 days, or another install → 403 `KEY_DECOMMISSIONED`;
  - `decommissioned` from the install that held it → a **signed `suspended` token** (reason `key_decommissioned`), recorded; from anywhere else → 403 `KEY_DECOMMISSIONED`.
- Licence found:
  - `install_id` null and `released_at` null and `activated_at` null (never bound) → bind (event `activated`, `via: "check"`);
  - `install_id` null and released → answer **without binding** (only `/v1/activate` binds a released key);
  - other install → 409 `KEY_IN_USE`, not recorded as a check-in, event `activation_refused` at most once an hour per IP.

- [ ] **Step 1: Failing tests** — update `body()` to pass `installId: A`; add: never-bound binds on first check; released answers without binding then `/v1/activate` from B binds and A's next check gets 409; other install 409 + no check-in row; rotated key from the bound install within 7 days → 200 current licence, at day 8 → 403; rotated key from another install → 403; decommissioned key from the holding install → token verifies with `state: "suspended"`; from another → 403.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** in `handleCheck` with the transaction + `FOR UPDATE` used by `record`. **Step 4:** PASS (whole `apps/licence` suite). **Step 5: Commit** `feat(licence): check-ins come from the bound install; retired keys never come back`.

---

### Task 5: Key actions — rotate (retires the old key), release, decommission, issue

**Files:** Modify `apps/licence/src/server/clients.ts`, `apps/licence/src/server/api.ts`, `apps/licence/src/server/clients.test.ts`

**Interfaces — Produces** (all return `{ licenseKey?: string, ...getClient }`):
- `rotateKey(ctx, id)` — new key (hash, last4, `key_enc`), old → `retired_keys(reason 'rotated', install_id = current)`, binding kept; events `key_rotated {last4}`, `key_decommissioned {last4, via: "rotate"}`
- `releaseKey(ctx, id)` — clears `install_id/activated_*`, sets `released_at`; event `key_released {ip}`; 409 `NOT_ACTIVE` if unbound
- `decommissionKey(ctx, id)` — current key → `retired_keys(reason 'decommissioned', install_id = current)`, `key_dead_at = now`, binding cleared, `key_enc` null; event `key_decommissioned {last4, via: "hold"}`; 409 if already dead
- `issueKey(ctx, id)` — only when `key_dead_at`: a new key, `key_dead_at` null, no binding; event `key_created`; returns `licenseKey`
- Routes: `POST /api/clients/:id/rotate` (existing), `POST /api/clients/:id/release`, `POST /api/clients/:id/key/decommission`, `POST /api/clients/:id/key/issue`

`key_dead_at` makes `/v1/activate` answer `KEY_DECOMMISSIONED` via `retired_keys` (the dead key is there) and the licence has no live hash: the `licences.key_hash` column is NOT NULL, so `decommissionKey` replaces it with `sha256("dead:" + clientId + ":" + now)` — a hash no key can produce, keeping the unique index happy.

- [ ] **Step 1: Failing tests** for each action including: rotate keeps `install_id`; the old key is in `retired_keys` with the install; release then rotate; decommission twice → 409; issue only after decommission; reveal after issue shows the new key; events in order.
- [ ] **Step 2–4:** fail → implement inside `tx(ctx, …)` with `lockRow` → pass. **Step 5: Commit** `feat(licence): rotate decommissions the old key; release; hold-to-decommission; issue a new key`.

---

### Task 6: Alerts and the client message

**Files:**
- Create: `apps/licence/src/lib/message.ts`, `apps/licence/src/lib/message.test.ts`
- Modify: `apps/licence/src/lib/alerts.ts` (+ tests in `alerts.test.ts`), `apps/licence/src/server/clients.ts` (`currentAlerts` feeds the new fields)

**Interfaces — Produces:**
- `AlertClient` gains `activation: ClientView["activation"]["status"]`, `createdAt: string`, `refusedAt: string | null` (newest `activation_refused` within 7 days), `refusedIp: string | null`
- Alerts: `tried:<id>` (red, fingerprint = refusedAt) "Key tried on another server — {name}" / "{ip}, {day at time}. Refused. A move, or a leaked key?"; `idle-key:<id>` (grey, fingerprint = createdAt) "Not activated after {n} days — {name}" / "Key issued {day}. Send the message again?" when `not_activated` and ≥ 7 days
- `clientMessage(slug: string, key: string): string` → `Your LUME is ready. Open https://${slug}.lumecrm.in and enter this product key when asked: ${key}. It works on one server only, so keep it private.`
- `whatsappLink(text: string, phone?: string | null): string` → `https://wa.me/${digits}?text=…` (no number → `https://wa.me/?text=…`)

- [ ] Steps: failing tests (exact strings above; tried alert hidden when older than 7 days; idle-key not for active/released/decommissioned) → implement → pass → commit `feat(licence): the bell knows a key tried elsewhere and one nobody entered; the client message`.

---

### Task 7: The panel — Ready to send, the Licence key card, Not activated, the bell

**Files:**
- Create: `apps/licence/src/components/KeyCard.tsx`, `apps/licence/src/components/HoldButton.tsx`, `apps/licence/src/components/ReadyToSend.tsx`, `apps/licence/src/lib/wa-mark.tsx` (the official WhatsApp paths from `apps/web/public/brand/whatsapp.svg`, verbatim, `fill="#25d366"`)
- Modify: `apps/licence/src/components/NewLicence.tsx` (after create → `ReadyToSend`), `ClientScreen.tsx` (replace its Licence key section with `KeyCard`), `ClientsScreen.tsx` (Not activated tile + pill), `Bell.tsx` (icons for `tried:` and `idle-key:`), `apps/licence/src/app/globals.css` (classes below), `panel.test.tsx`

Design source: canvas boards `DashReady`, `DashClient`, `DashClients` (approved). Exact copy is on those boards.

`HoldButton` (the one non-obvious piece of logic):

```tsx
"use client";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

/** Press and hold to confirm an irreversible action (owner, 2026-10-15). Letting go early springs back. */
export function HoldButton({ ms = 1500, label, busyLabel, onDone, describedBy }: {
  ms?: number; label: string; busyLabel: string; onDone: () => void; describedBy?: string;
}) {
  const [p, setP] = useState(0);
  const raf = useRef<number | null>(null);
  const done = useRef(false);
  const stop = () => { if (raf.current) cancelAnimationFrame(raf.current); raf.current = null; };
  useEffect(() => stop, []);
  const start = () => {
    if (raf.current || done.current) return;
    const t0 = performance.now() - p * ms;
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      setP(k);
      if (k >= 1) { stop(); done.current = true; onDone(); return; }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };
  const release = () => {
    if (done.current) return;
    stop();
    const from = p, t0 = performance.now();
    const back = (now: number) => {
      const k = Math.min(1, (now - t0) / 260);
      setP(k >= 1 ? 0 : from * Math.pow(1 - k, 3));
      if (k < 1) raf.current = requestAnimationFrame(back); else raf.current = null;
    };
    raf.current = requestAnimationFrame(back);
  };
  return (
    <button type="button" className="hold" aria-describedby={describedBy}
      onPointerDown={(e: PointerEvent<HTMLButtonElement>) => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); start(); }}
      onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}
      onKeyDown={(e: KeyboardEvent) => { if (!e.repeat && (e.key === " " || e.key === "Enter")) { e.preventDefault(); start(); } }}
      onKeyUp={release} onContextMenu={(e) => e.preventDefault()}>
      <span className="fill" style={{ transform: `scaleX(${p})` }} />
      <span className="lbl" style={{ color: p > 0.5 ? "#fff" : undefined }}>{p > 0 ? busyLabel : label}</span>
    </button>
  );
}
```

- [ ] **Step 1: Failing tests** (`panel.test.tsx`): after Create the sheet shows "Ready to send", the key, Copy key, Copy message (clipboard gets `clientMessage(...)`), a WhatsApp link to `wa.me`; the client page's key card shows each `activation.status` wording; Show calls `GET /api/clients/:id/key` and reveals it; Rotate and Release open inline confirms and call their routes; HoldButton: a short press (fake timers + rAF stub) does nothing, a 1.5 s hold calls `POST …/key/decommission` once; after it, "Key decommissioned" and Issue a new key; the Clients list shows a Not activated tile that filters; the bell renders `tried:`/`idle-key:` items.
- [ ] **Step 2–4:** fail → implement to the boards (Porcelain + Carbon both; `prefers-reduced-motion`) → pass. **Step 5: Commit** `feat(licence): the panel — Ready to send, the Licence key card with hold-to-decommission, Not activated, the bell`.

---

### Task 8: The instance keeps and activates its key

**Files:**
- Create: `packages/db/migrations/0065_licence_key.sql`
- Modify: `packages/db/src/schema/licence.ts`, `apps/api/src/licence/keeper.ts`, `apps/api/src/licence/options.ts` (comment), `apps/api/src/app.ts` (pass `deps.keyring`), `apps/api/src/licence/licence.test.ts`

```sql
-- packages/db/migrations/0065_licence_key.sql
-- Product key activation (spec 2026-10-15 §1.2): this install's own random id (sent with every check, so its key
-- works on this server only), and the key the owner gave, sealed, with the instance id the licence server named.
ALTER TABLE licence_state
  ADD COLUMN install_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN license_key_enc bytea,
  ADD COLUMN instance_id text,
  ADD COLUMN activated_at timestamptz;
```

**Interfaces — Produces** (on `LicenceKeeper`):
- `keySource(): "env" | "stored" | null`; `keyLast4(): string | null`
- `needsKey(): boolean` — `mode === "enforce" && keySource() !== "env"`
- `activate(key: string): Promise<ActivateOutcome>` where
  `type ActivateOutcome = { ok: true; view: LicenceView } | { ok: false; reason: "format" | "not_recognised" | "in_use" | "decommissioned" | "paused" | "too_many" | "unreachable" }`
- `info()` returns the effective `instanceId`
- Credentials: env (`opts.instanceId && opts.licenseKey`) win; else `licence_state.instance_id` + `keyring.decrypt(license_key_enc, "licence-key")`

`activate`: `canonicalKey(key)` or `format`; POST `${url}/v1/activate` with `activateBody({ licenseKey, installId, appVersion: opts.version, now })` (10 s timeout); map 401→`not_recognised`, 403 `LICENCE_PAUSED`→`paused`, 403 `KEY_DECOMMISSIONED`→`decommissioned`, 409→`in_use`, 429→`too_many`, anything else/network/bad JSON/unverifiable token (`verifyLicence(token, keys, body.instanceId)`)→`unreachable`. On success, ONE `UPDATE licence_state SET license_key_enc, instance_id, activated_at, token, last_attempt_at, last_success_at, last_error = NULL`; then `refresh()`. Nothing is written on any failure. `runCheck` sends `installId` and maps 403/409 to words ("This key has been decommissioned", "This key is in use on another server").

- [ ] **Step 1: Failing tests** (`licence.test.ts` with its fake fetch): a fresh install has an `install_id`; `needsKey()` true without env creds in enforce mode, false with them, false in dev; `activate(" lume 7k2p …")` posts exactly `activateBody` keys with the canonical key and stores sealed key + instance id + token (state active); each failure answer maps to its reason and stores nothing; with env creds set AND a stored key, checks send the env key; checks send `installId`.
- [ ] **Step 2–4:** fail → implement → pass. **Step 5: Commit** `feat(api): this install's id, its sealed key, and activation through the keeper`.

---

### Task 9: Setup asks for the key

**Files:** Modify `apps/api/src/modules/setup/routes.ts`, `apps/api/src/modules/setup/service.ts`, `apps/api/src/modules/setup/setup.test.ts`

**Interfaces — Produces:**
- `GET /api/v1/setup/status` → `{ needsSetup, needsKey }` (`needsKey` only meaningful while `needsSetup`)
- `POST /api/v1/setup/key` `{ key }` (public) → 200 `{ token, licence: { licenseType, paidUntil, trialEndsAt } }`; 403 `SETUP_DONE` when a user exists; 404 `NO_KEY_NEEDED` when `!needsKey()`; 429 `TOO_MANY` (`createLimiter({ perSource: 10, perInstance: 60, windowMs: 3_600_000 })` keyed by `req.ip`); 422 `KEY_REFUSED` with `details.reason` = the keeper's reason
- The token returned is `d.setupTokens.ensure()` — only in this answer.

- [ ] **Step 1: Failing tests** (harness with enforce mode, no env creds, fake fetch): approved key → token works for `/setup/totp` and `/setup`; refused key → 422 with each reason and no token; licence server down → 422 `unreachable`, nothing stored, then the same key succeeds; 11th try in an hour → 429; after setup → 403 `SETUP_DONE`; with env creds → status `needsKey: false` and `/setup/key` 404.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(api): setup's first step is the product key; approval hands that browser the setup token`.

---

### Task 10: Change key (owner)

**Files:** Modify `apps/api/src/licence/routes.ts`, `apps/api/src/licence/licence.test.ts`

**Interfaces — Produces:**
- `LicenceForPerson` gains `key: { masked: string | null; source: "env" | "stored" | null; canChange: boolean }` (`masked` = `LUME-••••-••••-••••-••••-` + last4; `canChange` = owner && source !== "env" && !dev)
- `POST /api/v1/licence/key` `{ key }` (permission `settings.manage`, then `req.actor.isOwner` else 403) → 200 `LicenceForPerson`; 409 `KEY_FROM_ENV`; 422 `KEY_REFUSED {reason}`; audit `licence.key_changed` `{ last4 }`

- [ ] Steps: failing tests (owner changes; admin non-owner 403; env source 409; refused key leaves the old key working; audit has last4 only, never the key) → implement → pass → commit `feat(api): the owner changes the product key in Settings → About`.

---

### Task 11: The `online` chime

**Files:** Modify `apps/web/src/lib/sound.ts`, `apps/web/src/lib/sound.test.ts`

```ts
// in CUE_NOTES — the fifth achievement (spec 2026-10-15 §1.1): LUME is online. Its last notes land 0.3 s in.
online: [
  { freq: 523.3, at: 0, dur: 0.5, gain: 0.022 },
  { freq: 659.3, at: 0.09, dur: 0.55, gain: 0.022 },
  { freq: 784, at: 0.18, dur: 0.7, gain: 0.021 },
  { freq: 1046.5, at: 0.3, dur: 1.1, gain: 0.02 },
  { freq: 1568, at: 0.3, dur: 1.3, gain: 0.012 },
],
```

`SoundCue` becomes `"done" | "sent" | "won" | "cleared" | "online"`; the header comment says five. Test: `online` exists, its gains ≤ 0.022, and its last note starts at 0.3 s (the harmony offset the moment relies on). Commit `feat(web): the online chime`.

---

### Task 12: The key step and the "your LUME is online" moment

**Files:**
- Create: `apps/web/src/components/setup/KeyStep.tsx`, `apps/web/src/components/setup/OnlineMoment.tsx`, `apps/web/src/components/setup/online.module.css`, tests `KeyStep.test.tsx`, `OnlineMoment.test.tsx`
- Modify: `apps/web/src/lib/setup-client.ts` (`activateKey`), `apps/web/src/components/setup/SetupWizard.tsx` (step 1 = KeyStep when `needsKey`; the token from activation feeds `onStartTotp`), `SetupScreen.tsx` + `apps/web/src/app/setup/page.tsx` (pass `needsKey`; hide the mark + LUME above the card while the moment plays), `SetupWizard.test.tsx`

**Interfaces — Produces:**
- `activateKey(key: string): Promise<{ ok: true; token: string; licence: { licenseType; paidUntil; trialEndsAt } } | { ok: false; reason: KeyRefusal }>`; `KeyRefusal = "format" | "not_recognised" | "in_use" | "decommissioned" | "paused" | "too_many" | "unreachable"`
- `REFUSAL_WORDS: Record<KeyRefusal, string>` (exact strings from the spec §1.1 and the canvas)
- `<KeyStep onApproved(token, licence) />`, `<OnlineMoment licence onProceed reduce />`

Behaviour (canvas `Main`, `KeyStates`, `KeyObsidian`, `KeyPhone`):
- The field shows `displayKey(raw)`, the 5-segment meter, the hint ("Five groups of four. Dashes and spaces don't matter." / "{n} more groups to go" / "Looks complete"); Continue enabled at 20 chars; "Checking with LUME…" with the spinner; refusals in the alert box (amber for `unreachable`, button "Try again"); "Use another key".
- On approval the wizard keeps the token in state, then renders `OnlineMoment`: CSS keyframes from the canvas (rise 0.05 s/0.62 s, turn 0.62 s/0.82 s overshoot, ring 1.40 s/0.72 s, pulse + badge 2.1 s, tick 2.3 s, words 2.25/2.36/2.5 s); `useSound().play("online")` at 1.82 s (immediately with reduced motion) via a timer cleared on unmount; `role="status"` text "Congratulations — your LUME is online"; Proceed to onboarding → step 2 (business) with the token already held (`onStartTotp(token)` runs then).
- Reduced motion: no keyframes, final frame, chime at once.

- [ ] **Step 1: Failing tests** — KeyStep: typing `7k2p q9xd` shows `LUME-7K2P-Q9XD` and "3 more groups to go"; Continue disabled until 20; each refusal shows its exact words and nothing else changes; `unreachable` shows Try again; OnlineMoment: status text present, Proceed calls `onProceed`, sound `play("online")` called once after 1820 ms (fake timers) and at 0 with `reduce`; Wizard: with `needsKey` the first step is the key, Proceed leads to "About the business", completing setup posts the activation's token.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(web): the product key step, and the "your LUME is online" moment with its chime`.

---

### Task 13: Change key in Settings → About

**Files:** Modify `apps/web/src/lib/licence/client.ts` (`changeKey`), `apps/web/src/components/licence/LicenceCard.tsx`, `apps/web/src/components/licence/licence.module.css`, `apps/web/src/components/licence/Licence.test.tsx`; the "What LUME tells its licence server" chips gain "Install ID" with the sentence from the canvas `AboutKey`.

- [ ] Steps: failing tests (masked key row; Change key only when `key.canChange`; Save sends the key, success updates the card and closes, refusal shows the exact words; "Key set on the server" when `source === "env"`) → implement to the `AboutKey` board → pass → commit `feat(web): Settings → About shows the product key, and the owner can change it`.

---

### Task 14: Ops — provisioning and runbooks

**Files:** Modify `scripts/provision.sh` (`LUME_LICENSE_KEY` optional; when absent no `LUME_LICENSE_KEY`/`LUME_INSTANCE_ID` lines; the closing line: `Send <client> their address https://<slug>.lumecrm.in and their product key (Copy message on license.lumecrm.in). LUME asks for the key at the first step of setup.`), `scripts/fleet/*.test.*` if they pin the old text, `docs/runbooks/fleet.md` (steps 6–8), `docs/runbooks/licence-server.md` (activation, release, rotate, decommission; deploy step for migration 0004), `CHANGELOG.md`.

- [ ] Steps: update the provision test for both modes → run `vitest run scripts` + `shellcheck scripts/provision.sh` (toolbox) → commit `docs(ops): provisioning without a key in .env; the activation runbook`.

---

### Task 15: Full checks, e2e references, push

- [ ] Run the full gate (Global Constraints), the full e2e (`cd apps/web && pnpm e2e --update-snapshots=changed`) and review every changed reference before accepting it; `apps/licence` e2e too.
- [ ] Commit any accepted references; push main; watch CI to green.

---

### Task 16: Live — the licence server, a fresh install, a fresh reviewer

- [ ] **Licence server deploy** (owner's host, `/root/lume-licence`): `pg_dump` backup first; rebuild the image from main; migrate (0004); `healthz` 200; an existing licence still checks in.
- [ ] **A throwaway install** on the dev box (its own compose project, like `lumedemo`), `LUME_LICENSE_MODE=enforce`, no key in `.env`, pointing at license.lumecrm.in; a throwaway licence on the dashboard ("Live check — delete me").
- [ ] Walk it with a Playwright review script, screenshots in both themes and on a phone: key step, each refusal (wrong key; the same key from a second throwaway install → in use), the moment (frames at 0.3, 1.0, 1.8, 2.6 s), Proceed → setup → Today; Settings → About → Change key after a Rotate (old key keeps the server for now; new key accepted); Release; hold-to-decommission → the install pauses at its next check (Check now).
- [ ] Tear down the throwaway installs; decommission and delete the throwaway licence; confirm app.lumecrm.in and the client site still answer 200.
- [ ] **Fresh review** with superpowers:requesting-code-review over the whole change; fix every Important finding (RED→GREEN), push, CI green.
- [ ] Summary doc `docs/product-key-activation-2026-10-15.md` (every ruling, deferred minors), memory updated, report to the owner.
