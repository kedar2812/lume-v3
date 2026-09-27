# Phase 2C — Inbound webhooks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any tool that can post JSON (a website form, Zapier, Make, and ManyChat once verified) posts to a private LUME address. Each post becomes a lead within seconds, through the same engine as CSV and Sheets.

**Architecture:**
- **Receiving.** A public route, with no session and no CSRF, authenticates each post by the source's own secret: an HMAC signature, or a header token. It then:
  - drops replays by event key;
  - rate-limits in memory;
  - stores the payload encrypted;
  - answers `202`;
  - hands the event to a pg-boss job (`webhooks.process`) in the API process.
- **Processing.** The job flattens the JSON into cells by path and calls the shared `writeRow` (2B-1 Task 4).
- **Setup.** A test post's paths become the "headers" of a 2A draft, so Columns, Rules and Preview are the import steps (2B A1).

**Tech Stack:** Fastify 5 (a raw-body content parser scoped to the route), `node:crypto`, Drizzle, pg-boss 10, Next.js 16, Vitest and Playwright.

**Spec:** `docs/superpowers/specs/2026-09-28-phase-2c-webhooks-design.md`. It follows 2B (`docs/superpowers/specs/2026-09-27-phase-2b-google-sheets-design.md`, A1–A13).

## Global Constraints

- **The module:** optional and off by default. It is managed with `integrations.manage`. With it off, `POST /webhooks/in/:id` answers `401`, and no Webhooks UI shows beyond the switch.
- **The secret:**
  - 32 random bytes, base64url;
  - encrypted at rest (keyring, context `webhook-source:<id>`);
  - returned by the API **only** in the create and rotate responses;
  - compared in constant time;
  - never logged. The receive route's logs carry the source id and status only, never headers or body.
- **Receive answers:** `202`, `401`, `413`, `415`, `400`, `429` and `503` only. There is no body detail beyond `{ "accepted": true }`, `{ "accepted": true, "duplicate": true }` or `{ "error": "<code>" }`, and never the source name or the reason a check failed.
- **Payloads** are at most 64 KB, stored encrypted, and cleared 30 days after processing (problem events keep theirs until resolved).
- **The ManyChat preset is hidden** unless `LUME_MANYCHAT_PRESET=on` (owner, 2026-09-27: hidden until verified).
- **Copy** speaks as "LUME". One accent blue. Official marks from `/brand/` (add `zapier.png`, `make.png` and `manychat.png` from each company's brand page, with README rows; if a mark can't be fetched from the official source, show the name without a mark rather than drawing one). No sound.
- **Gate, commits, pushes and test commands:** as in 2B-1.
- **Test data** is fictional.

## Review Focus

1. **Timing.** An unknown source id must not be distinguishable from a wrong secret. Both return `401`, and the secret check runs a constant-time compare against a dummy when the source is missing. *Test: Task 3 "unknown source looks like a bad secret".*
2. **A body that isn't what the signature covered.** The HMAC is computed over the raw bytes received, never over re-serialised JSON. *Test: Task 3 "signature over the raw body: whitespace matters".*
3. **The same event twice at the same moment** (a sender retrying on timeout). One event row, one lead. *Test: Task 3 "concurrent duplicates make one event".*
4. **A payload with arrays of objects, deep nesting or huge strings.** Unmappable paths are listed but not mapped. Cells over 10,000 characters are problems, not crashes. *Test: Task 2 flatten cases, and Task 4 "a huge cell is a problem".*
5. **The person the source runs as loses access** while posts keep coming. The posts are accepted and queued, the source needs attention, and they process after an admin saves it. *Test: Task 4 "posts wait while the source needs attention".*

---

### Task 1: Data, config and queue

**Files:**
- `packages/db/migrations/0019_webhooks.sql`;
- `packages/db/src/schema/intake.ts` (`webhookEvents`, the new `lead_sources` columns, `imports.kind` gaining `"webhook"`);
- `packages/db/src/intake.test.ts`;
- `packages/core/src/queues.ts` and its test (`webhooks.process`, `webhooks.retention`);
- `packages/config/src/schema.ts` and its test (`LUME_MANYCHAT_PRESET: z.enum(["on", "off"]).default("off")`);
- `apps/worker/src/maintenance.ts`, `apps/worker/src/boss.ts` and their tests (`purgeWebhookEvents`).

**Interfaces:**
- `schema.webhookEvents`: `{ id: number; sourceId; eventKey; payloadEnc; receivedAt; status: "test" | "queued" | "done" | "error" | "dismissed"; result: "created" | "merged" | "skipped" | null; leadId; problems; processedAt }`.
- `leadSources` gains `rejected: number`, `lastRejectedReason: string | null` and `lastEventAt: Date | null`.
- `imports.kind` becomes `"csv" | "sheet" | "webhook"`.
- `purgeWebhookEvents(): Promise<{ cleared: number; deleted: number }>`.

- [ ] **Step 1: Failing tests.**

  DB (append to `intake.test.ts`, using its `query(role, sql)` helper):
  - a webhook source and events insert;
  - `(source_id, event_key)` is unique (`webhook_events_once`);
  - an event status outside the list is refused;
  - the worker can `SELECT (id, status, processed_at, received_at)`, `UPDATE (payload_enc)` and `DELETE`, but can't read `payload_enc` or `problems`.

  Worker (append to `maintenance.integration.test.ts`):
  - `purgeWebhookEvents` clears `payload_enc` of `done` events processed more than 30 days ago;
  - it deletes every event received more than 90 days ago;
  - it leaves `error` events' payloads;
  - it returns `{ cleared, deleted }`, and a second run gives zeros.

  Config: `LUME_MANYCHAT_PRESET` defaults to `"off"` and accepts `"on"`.

  Queues test: the list gains `webhooks.process` and `webhooks.retention`, after the sheet queues.

- [ ] **Step 2: Run them and watch them fail.** Run `bash scripts/dev.sh run bash -c 'pnpm exec vitest run packages/db packages/config packages/core/src/queues.test.ts apps/worker'`.

- [ ] **Step 3: Implement.** `0019_webhooks.sql`:

```sql
-- Phase 2C (spec 2026-09-28-phase-2c §3): a webhook is a lead source that is posted to. Every accepted
-- post is one event, kept encrypted until it's dealt with; refused posts are only counted.
ALTER TABLE lead_sources
  ADD COLUMN rejected integer NOT NULL DEFAULT 0,
  ADD COLUMN last_rejected_reason text,
  ADD COLUMN last_event_at timestamptz;

ALTER TABLE imports DROP CONSTRAINT imports_kind;
ALTER TABLE imports ADD CONSTRAINT imports_kind CHECK (kind IN ('csv', 'sheet', 'webhook'));

CREATE TABLE webhook_events (
  id bigserial PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES lead_sources (id) ON DELETE CASCADE,
  event_key text NOT NULL,
  payload_enc bytea,
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CONSTRAINT webhook_events_status CHECK (status IN ('test', 'queued', 'done', 'error', 'dismissed')),
  result text CONSTRAINT webhook_events_result CHECK (result IN ('created', 'merged', 'skipped')),
  lead_id uuid,
  problems jsonb NOT NULL DEFAULT '[]'::jsonb,
  processed_at timestamptz,
  CONSTRAINT webhook_events_once UNIQUE (source_id, event_key)
);
CREATE INDEX webhook_events_recent ON webhook_events (source_id, received_at DESC);
CREATE INDEX webhook_events_problems ON webhook_events (source_id) WHERE status = 'error';

REVOKE ALL ON webhook_events FROM lume_worker;
REVOKE ALL ON SEQUENCE webhook_events_id_seq FROM lume_worker;
GRANT SELECT (id, status, processed_at, received_at), UPDATE (payload_enc), DELETE ON webhook_events TO lume_worker;
```

The Drizzle schema mirrors it (the drift test checks it). The worker's sweep:

```ts
    /** 2C spec §3: a handled post's payload goes after 30 days; every event after 90. Problems keep theirs. */
    async purgeWebhookEvents() {
      const t = now().getTime();
      const cleared = await pool.query(
        "UPDATE webhook_events SET payload_enc = NULL WHERE status = 'done' AND processed_at < $1 AND payload_enc IS NOT NULL",
        [new Date(t - 30 * 86_400_000)],
      );
      const deleted = await pool.query("DELETE FROM webhook_events WHERE received_at < $1", [new Date(t - 90 * 86_400_000)]);
      return { cleared: cleared.rowCount ?? 0, deleted: deleted.rowCount ?? 0 };
    },
```

It is scheduled as `webhooks.retention` at `47 3 * * *`. Update the boss test's schedule list and its mocks, as 2B-1 Task 1 did.

In `imports/service.ts`, `listImports`'s `ne(I.kind, "sheet")` becomes `eq(I.kind, "csv")`, so no setup draft of any kind is listed.

- [ ] **Step 4: Run the tests** (the Step 2 command). Expected: PASS, including the drift test.

- [ ] **Step 5: Gate, commit, push.** Message: `feat(db): webhook sources count what they refuse, and keep each accepted post as one event`.

---

### Task 2: Payloads, paths and presets (pure)

**Files:**
- Create: `apps/api/src/modules/webhooks/payload.ts`, `apps/api/src/modules/webhooks/presets.ts`
- Test: `apps/api/src/modules/webhooks/payload.test.ts`, `apps/api/src/modules/webhooks/presets.test.ts`

**Interfaces:**
- `parseBody(raw: Buffer, contentType: string | undefined): { ok: true; value: Record<string, unknown> } | { ok: false; status: 400 | 415; code: "BAD_JSON" | "NOT_OBJECT" | "UNSUPPORTED_TYPE" }`
- `flatten(value: Record<string, unknown>): { cells: Map<string, string>; unmappable: string[] }`:
  - paths are joined with `.`;
  - arrays of scalars become `path[]`, their items joined with ", ";
  - arrays containing objects, and objects nested more than 5 deep, are listed in `unmappable`, not in `cells`;
  - `null` becomes `""`;
  - numbers and booleans are stringified.
- `pathsOf(value): string[]`: the `cells` keys, in first-seen order.
- `cellsFor(headers: string[], cells: Map<string, string>): string[]`
- `type Preset = "website" | "zapier" | "make" | "manychat"`
- `PRESETS: Record<Preset, { label: string; mark: string | null; mode: "signed" | "token"; paths: Record<string, string>; hidden?: boolean }>`, where `paths` maps a JSON path to a field key or name part (`"name_part:first"`).
- `presetMapping(preset: Preset, headers: string[], fields: IntakeField[]): Mapping`:
  - the preset's paths map first;
  - any other header falls back to `suggestMapping` on its last path segment;
  - `custom_fields.<key>` maps to a custom field with that key or label, when one exists.

- [ ] **Step 1: Failing tests.** `payload.test.ts` covers:
  - JSON objects, and form bodies (`a=1&b=two+words` becomes `{ a: "1", b: "two words" }`);
  - bad JSON, a top-level array, and a `text/plain` type;
  - flatten on this payload:

    ```ts
    {
      name: "Aisha Khan",
      contact: { phone: "+971501234567", email: null },
      tags: ["vip", "ad"],
      custom_fields: { budget: 900, callback: true },
      items: [{ a: 1 }],
      deep: { a: { b: { c: { d: { e: { f: 1 } } } } } },
    }
    ```

    giving the cells `name`, `contact.phone`, `contact.email` (`""`), `tags[]` (`"vip, ad"`), `custom_fields.budget` (`"900"`) and `custom_fields.callback` (`"true"`), and `unmappable` of `items` and `deep.a.b.c.d`;
  - `cellsFor` in header order, with `""` for a missing path.

  `presets.test.ts` covers:
  - the website preset on `name/phone/email` maps them to name, phone and email;
  - ManyChat's documented subscriber payload (`first_name`, `last_name`, `phone`, `email`, `ig_username`, `custom_fields.budget`) maps first/last name parts, phone, email, instagram, and budget to a custom field keyed `budget` when the test context has one;
  - `PRESETS.manychat.hidden` is `true`.

- [ ] **Step 2: Watch them fail.**

- [ ] **Step 3: Implement** `payload.ts`:

```ts
import type { Mapping } from "@lume/core";

type Json = Record<string, unknown>;
const MAX_DEPTH = 5;

/** 2C spec §4 step 4: JSON (an object at the top), or a plain HTML form. Anything else is refused. */
export function parseBody(
  raw: Buffer,
  contentType: string | undefined,
): { ok: true; value: Json } | { ok: false; status: 400 | 415; code: "BAD_JSON" | "NOT_OBJECT" | "UNSUPPORTED_TYPE" } {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type === "application/x-www-form-urlencoded")
    return { ok: true, value: Object.fromEntries(new URLSearchParams(raw.toString("utf8"))) };
  if (type !== "application/json") return { ok: false, status: 415, code: "UNSUPPORTED_TYPE" };
  let v: unknown;
  try {
    v = JSON.parse(raw.toString("utf8"));
  } catch {
    return { ok: false, status: 400, code: "BAD_JSON" };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, status: 400, code: "NOT_OBJECT" };
  return { ok: true, value: v as Json };
}

const scalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/** A payload as cells by path (2C spec §2 "Nested values"): one value per path, or listed as unmappable. */
export function flatten(value: Json): { cells: Map<string, string>; unmappable: string[] } {
  const cells = new Map<string, string>();
  const unmappable: string[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (scalar(v)) return void cells.set(path, text(v));
    if (Array.isArray(v)) {
      if (v.every(scalar)) return void cells.set(`${path}[]`, v.map(text).filter(Boolean).join(", "));
      return void unmappable.push(path);
    }
    if (v && typeof v === "object") {
      if (depth >= MAX_DEPTH) return void unmappable.push(path);
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, depth + 1);
    }
  };
  walk(value, "", 0);
  return { cells, unmappable };
}

export const pathsOf = (value: Json): string[] => [...flatten(value).cells.keys()];
export const cellsFor = (headers: string[], cells: Map<string, string>): string[] => headers.map((h) => cells.get(h) ?? "");
export type { Mapping };
```

`presets.ts`: the `PRESETS` record. The website, zapier and make presets share the `paths` `{ name: "name", phone: "phone", email: "email", instagram: "instagram" }`. Their marks are `/brand/zapier.png` and `/brand/make.png` for zapier and make, and `null` for website. ManyChat has `mode: "token"`, `hidden: true`, and the paths `{ first_name: "name_part:first", last_name: "name_part:last", phone: "phone", email: "email", ig_username: "instagram" }`.

`presetMapping`:
- builds a `suggestMapping(lastSegments, fields, null)` (where `lastSegments = headers.map((h) => h.replace(/\[\]$/, "").split(".").at(-1)!)`);
- overrides it column by column: a preset path gives `{ to: "field", field }`, or `{ to: "name_part", part }`;
- maps `custom_fields.<k>` headers to the non-archived custom field whose key is `<k>`, or whose folded label equals folded `<k>`.

- [ ] **Step 4: Run the tests** (they pass). **Step 5: Gate, commit.** Message: `feat(api): read a webhook's JSON as cells by path, and the presets that match them`.

---

### Task 3: Receiving

**Files:**
- Create: `apps/api/src/modules/webhooks/receive.ts`, `apps/api/src/modules/webhooks/limits.ts`, `apps/api/src/modules/webhooks/secret.ts`
- Modify: `apps/api/src/app.ts` (register `receiveRoutes` **outside** the authenticated scope, next to the health routes; read how `health.ts` is registered and do the same)
- Test: `apps/api/src/modules/webhooks/receive.test.ts`

**Interfaces:**
- `secret.ts`:
  - `type WebhookConfig = { mode: "signed" | "token"; secret: string; preset: Preset }`
  - `sealWebhook(k, sourceId, c)` / `openWebhook(k, sourceId, blob)`
  - `newSecret(): string`
  - `checkSignature(secret, ts: string | undefined, sig: string | undefined, raw: Buffer, now: number): boolean`
  - `checkToken(secret, token: string | undefined): boolean`
  - `signFor(secret, ts: string, raw: Buffer): string`, for tests and the code sample: `sha256=<hex>`.
- `limits.ts`: `createLimiter(o: { perSource: number; perInstance: number; windowMs: number; now?: () => number }): { take(sourceId: string): { ok: true } | { ok: false; retryAfterSec: number } }`
- `receive.ts`: `receiveRoutes(app, d: AppDeps)`, which registers `POST /webhooks/in/:id`.
- `AppDeps.webhooks?: { enqueue(eventId: number): Promise<void> }`

- [ ] **Step 1: Failing tests** `receive.test.ts`. Use the harness (`createHarness({ preset: "general" })`). Arrange the source directly in the database, as 2B-1's sync test did:
  - `type 'webhook'`, `status 'active'`, and `config_enc = sealWebhook(...)` with a known secret;
  - the module is switched on: `UPDATE settings SET integrations = integrations || '{"webhooks":{"enabled":true}}'`.

  Post with `h.app.inject({ method: "POST", url: \`/webhooks/in/${id}\`, headers, payload: raw })`. The cases:
  - **signed:** valid gives `202 { accepted: true }` and one `webhook_events` row with `status 'queued'`, and `enqueue` was called with its id. A bad signature gives 401. A timestamp 301 s old gives 401. Missing headers give 401.
  - **Review Focus 2:** "signature over the raw body: whitespace matters". Sign `{"a":1}`, then send `{ "a": 1 }`: 401.
  - **token:** a correct `X-Lume-Token` gives 202; a wrong one gives 401.
  - **Review Focus 1:** "unknown source looks like a bad secret". A random uuid gives 401 with the same body as a bad secret (`{ "error": "unauthorized" }`).
  - **A paused source** gives 503 with a `retry-after` header. **The module off** gives 401.
  - **Replay:** the same `X-Lume-Event-Id` twice gives the second `202 { accepted: true, duplicate: true }` and one row. With no event id, identical bodies are one row.
  - **Review Focus 3:** "concurrent duplicates make one event". `Promise.all` of 5 identical posts gives exactly 1 row.
  - **Limits:**
    - the 61st post in a minute gives 429 with `retry-after` (the harness passes a limiter with `perSource: 60`);
    - 65 KB gives 413;
    - `text/plain` gives 415;
    - bad JSON gives 400;
    - a form-encoded body is accepted.
  - **Refused posts** increment `lead_sources.rejected` and set `last_rejected_reason` (for example `bad_signature`), and store no event.
  - **A source in `draft`** (setting up) accepts a correctly authenticated post as `status 'test'` and does not enqueue it.

- [ ] **Step 2: Watch them fail.**

- [ ] **Step 3: Implement.**

`secret.ts`:

```ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Keyring } from "@lume/core";
import type { Preset } from "./presets";

export type WebhookConfig = { mode: "signed" | "token"; secret: string; preset: Preset };
const ctx = (id: string) => `webhook-source:${id}`;
export const sealWebhook = (k: Keyring, id: string, c: WebhookConfig) => k.encrypt(JSON.stringify(c), ctx(id));
export const openWebhook = (k: Keyring, id: string, blob: Buffer) => JSON.parse(k.decrypt(blob, ctx(id))) as WebhookConfig;
export const newSecret = () => randomBytes(32).toString("base64url");

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // Compare equal-length buffers even on a length mismatch, so the time taken says nothing.
  return timingSafeEqual(x.length === y.length ? x : y, y) && x.length === y.length;
};
export const signFor = (secret: string, ts: string, raw: Buffer) =>
  `sha256=${createHmac("sha256", secret).update(`${ts}.`).update(raw).digest("hex")}`;

/** 2C spec §2 Signed: HMAC-SHA256 of "<timestamp>.<raw body>", with the timestamp within 5 minutes. */
export function checkSignature(secret: string, ts: string | undefined, sig: string | undefined, raw: Buffer, now: number) {
  if (!ts || !sig || !/^\d{9,11}$/.test(ts) || Math.abs(now / 1000 - Number(ts)) > 300) return false;
  return same(signFor(secret, ts, raw), sig);
}
export const checkToken = (secret: string, token: string | undefined) => !!token && same(secret, token);
```

`limits.ts`: fixed one-minute windows per key (`"i"` for the instance, the source id for a source), in a `Map`, pruned when it passes 10,000 keys. It is in memory: one API process serves an instance (spec §2 Rate), which is recorded as a ruling in the ledger.

`receive.ts`, the route:

```ts
  app.addContentTypeParser(["application/json", "application/x-www-form-urlencoded"], { parseAs: "buffer", bodyLimit: 65_536 }, (_r, body, done) => done(null, body));
  app.post("/webhooks/in/:id", { config: { public: true, csrf: false, db: false }, bodyLimit: 65_536 }, async (req, reply) => { … });
```

It is registered in its own encapsulated plugin, so the buffer parser applies only here. The handler, in the spec §4 order:
1. The limiter gives 429 with `Retry-After`.
2. The source is loaded via `drizzle(d.pool)`, since there is no request transaction on a public `db:false` route. If it is missing, not a webhook, archived, or the module is off, run `checkToken(DUMMY, …)` or `checkSignature(DUMMY, …)` to spend the same time, then 401.
3. Open its config and authenticate by mode. On failure, `UPDATE lead_sources SET rejected = rejected + 1, last_rejected_reason = $reason`, then 401.
4. Paused or needs attention (for `RUN_AS_ACCESS`, keep accepting; spec §5): `paused` gives 503 with `Retry-After: 3600`; `needs_attention` is accepted and queued.
5. `parseBody` failures count as rejected (`bad_json`, `unsupported_type`) and return their status.
6. `eventKey = header x-lume-event-id (≤200) ?? sha256(raw)`.
7. `INSERT … ON CONFLICT ON CONSTRAINT webhook_events_once DO NOTHING RETURNING id`, with `payload_enc = keyring.encrypt(raw.toString("utf8"), \`webhook-event:${sourceId}:${eventKey}\`)` and `status = source.status === 'draft' ? 'test' : 'queued'`.
8. `UPDATE lead_sources SET last_event_at = now()`.
9. If a row was inserted and it is `queued`, `await d.webhooks?.enqueue(id)`.
10. Reply 202, with `duplicate: true` when no row was inserted.

A 413 comes from Fastify's `bodyLimit`. Map its error to `{ error: "too_large" }` in a route-level `errorHandler`, and count it as rejected.

The harness passes `webhooks: { enqueue: async (id) => void events.push(id) }` and exposes `runWebhooks()` (Task 4).

- [ ] **Step 4: Run the tests** (they pass). **Step 5: Gate, commit.** Message: `feat(api): receive webhooks — signed or token, replay-safe, rate-limited, and nothing forged gets in`.

---

### Task 4: Processing

**Files:**
- Create: `apps/api/src/modules/webhooks/process.ts`, `apps/api/src/modules/webhooks/queue.ts`
- Modify: `apps/api/src/main.ts`, `apps/api/test/harness.ts` (`runWebhooks`), `apps/api/src/modules/leads/query.ts` (arrivals include `webhook` sources)
- Test: `apps/api/src/modules/webhooks/process.test.ts`

**Interfaces:**
- `processEvent(o: { app; pool; keyring }, eventId: number): Promise<void>`
- `startWebhookQueue(o): { enqueue(id: number): Promise<void>; stop(): Promise<void> }`: a pg-boss worker for `webhooks.process`, `batchSize 1`, `pollingIntervalSeconds 0.5`, with retries `retryLimit: 5`.

- [ ] **Step 1: Failing tests** `process.test.ts`: a live webhook source whose `headers = ["name","contact.phone","email"]`, whose mapping maps them, and whose `run_as` is an admin.
  - A queued event becomes a lead with an `imported` activity whose payload names the webhook and the event (`{ sourceId, webhook: name, event: id }`). The event ends `done/created` with `lead_id`, and `last_event_at` is set.
  - A second post with the same phone merges: `done/merged`, with "Enquired again".
  - A post with an unreadable date in a mapped date path becomes `error` with problems. After the rules change (`config_version` + 1), `POST …/retry` (Task 5), or directly `processEvent` again, makes it `done`.
  - **Review Focus 4:** "a huge cell is a problem": a 12,000-character name gives `error`, not a throw.
  - **Review Focus 5:** "posts wait while the source needs attention". Revoke the admin's Import, and processing sets the source to `needs_attention/RUN_AS_ACCESS`, while the event stays `queued`. Restore the grant, and `processEvent` makes it `done`.
  - A post with a path the mapping doesn't know adds it to the source's `new_columns`.
  - `GET /api/v1/leads/arrivals`, after a webhook lead, counts it for the admin it runs as.

- [ ] **Step 2: Watch them fail.**

- [ ] **Step 3: Implement** `process.ts`:
- load the event and source; if the event isn't `queued`/`error`, return;
- run the source's `run_as` check (reuse 2B-1's rule: `leads.import`, and `leads.assign` when the rules give leads away). On failure, set the source to `needs_attention`, with `attention_code = 'RUN_AS_ACCESS'` and a message naming the person; leave the event `queued`; return;
- decrypt the payload, `parseBody` it, and `flatten` it; add unknown paths to `new_columns`;
- `cellsFor(source.headers, cells)`; any cell over 10,000 characters becomes an `error` with `CELL_TOO_LONG` "A value is over 10,000 characters.";
- in `withJobRequest` as the `run_as` actor with `allLeads`, call `loadMapContext` and `writeRow` with `origin: { sourceId, webhook: source.name, event: id }` and `nextTurn` over `lead_sources.rr_cursor`;
- update the event (`status`, `result`, `lead_id`, `problems`, `processed_at`); on `done`, set `payload_enc` to null only after 30 days (retention does that);
- wrap it like the runner: a data error (`isDataError`) becomes `error` with `ROW_NOT_SAVED` via `refusalReason`; any other throw propagates (pg-boss retries).

`history.ts` (web, in Task 6) reads `p.webhook` like `p.sheet`: `const origin = p.file ?? p.sheet ?? p.webhook;`.

`leads/query.ts` `arrivalsWhere`: `s.type IN ('google_sheet', 'webhook')`.

`queue.ts` mirrors `startSheetsQueue` without a ticker. In `main.ts`, it starts when the API starts, whether or not the module is on (the module switch gates receiving), and passes `webhooks: { enqueue }` to `buildApp`, filled after start as `sheets` is.

- [ ] **Step 4: Run the tests** (they pass). **Step 5: Gate, commit.** Message: `feat(api): every accepted post becomes a lead through the same engine, and waits safely when it can't yet`.

---

### Task 5: Managing webhooks (API)

**Files:**
- Create: `apps/api/src/modules/webhooks/service.ts`, `apps/api/src/modules/webhooks/routes.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/test/probes.ts`, `apps/api/src/modules/sheets/service.ts` (`integrationsView` gains `webhooks: { enabled, manychat }`), `apps/web/src/lib/settings/audit.ts`
- Test: `apps/api/src/modules/webhooks/webhooks.test.ts`

**Interfaces** (spec §7; every route needs `integrations.manage`):

| Route | Returns |
|---|---|
| `PUT /api/v1/integrations/webhooks` `{ enabled }` | The integrations view |
| `POST /api/v1/webhooks/sources` `{ preset, name }` | `201 { source: WebhookView, address: string, secret: string, mode }`. The source is `draft`, and `run_as` is the caller. `preset` must be visible (ManyChat only with `LUME_MANYCHAT_PRESET=on`). |
| `GET /api/v1/webhooks/sources` | `{ sources: WebhookView[] }` |
| `GET /api/v1/webhooks/sources/:id` | `WebhookDetail`: `WebhookView` plus `events` (the last 20: `id`, `receivedAt`, `status`, `result`, `leadId`) and `problems` (`error` events with their reasons) |
| `GET /api/v1/webhooks/sources/:id/test` | `200 { paths, unmappable, receivedAt }` for the newest `test` event, or `204` |
| `POST /api/v1/webhooks/sources/:id/draft` | `201 DraftView`. The draft's CSV is `[paths, cellsFor(paths, flat)]`, from the newest `test` event (while setting up) or the newest event (when editing). Its mapping is `presetMapping` (new) or the source's mapping (edit). `imports.kind = 'webhook'`, and `target_source_id` is the source. Needs `leads.import` too (`CANNOT_IMPORT`). |
| `POST /api/v1/webhooks/sources/:id/save` `{ importId, keepTest: boolean }` | `WebhookView` |

`save` does the following:
- runs `prepareStart(req, d, imp, { keepCreatingTags: true })` (2B-1);
- sets `mapping`, `rules`, `column_settings` and `headers` (the draft's), `run_as = caller` and `config_version + 1`;
- turns `draft` into `active`, and clears `needs_attention` (`COLUMNS_CHANGED`/`RUN_AS_ACCESS`) to active;
- deletes the draft;
- with `keepTest`, requeues the newest `test` event (`status 'queued'`, enqueue); without it, marks it `dismissed`;
- requeues every `queued` event (the ones waiting through a pause);
- audits `webhook.connected` (first save) or `webhook.mapping_changed`.

The remaining routes:

| Route | Does |
|---|---|
| `PATCH /api/v1/webhooks/sources/:id` `{ name?, paused? }` | Name, pause or resume (audited) |
| `POST /api/v1/webhooks/sources/:id/rotate` | `{ secret }` (audited `webhook.secret_rotated`; the old secret stops at once) |
| `POST /api/v1/webhooks/sources/:id/events/:eventId/retry` | 202 (the event is re-queued) |
| `POST /api/v1/webhooks/sources/:id/events/:eventId/dismiss` | 204 |
| `DELETE /api/v1/webhooks/sources/:id` | 204 (archive; audited `webhook.removed`) |

```ts
type WebhookView = {
  id: string; name: string; status: "draft" | "active" | "paused" | "needs_attention";
  attention: { code: string; message: string } | null;
  preset: Preset; mode: "signed" | "token"; address: string;
  lastEventAt: string | null; eventsToday: number; eventsAllTime: number;
  created: number; merged: number; problems: number;
  rejected: number; lastRejectedReason: string | null;
  newColumns: string[]; runAs: { id: string; name: string } | null;
}
```

`address` is `${config.publicUrl}/webhooks/in/${id}`. The Caddy edge routes `/webhooks/*` to the API: check `infra/Caddyfile` and add the route if only `/api/*` goes there.

- [ ] **Step 1: Failing tests** `webhooks.test.ts`:
  - the module is off by default; switching it on is audited;
  - create (the Website preset) returns the address and secret once; `GET` never shows the secret;
  - a hidden ManyChat preset gives 400 `PRESET_HIDDEN`;
  - a signed test post (built with `signFor`) arrives as `test`, and `GET …/test` lists its paths;
  - draft, then `/imports/:id/preview` works, then save with `keepTest: true`, then `runWebhooks`, gives one lead;
  - rotate: the old secret gives 401 and the new one 202;
  - pause gives 503, resume gives 202;
  - retry and dismiss a problem event;
  - remove archives, and posts give 401;
  - someone with `integrations.manage` but not `leads.import` can't draft (`CANNOT_IMPORT`).

  The probes cover every route above. The receive route is `access: "public"`, with body `{}` and the path `/webhooks/in/${uuid}`. Check how `probes.ts` treats `public` routes: a public route must answer without a session, and 401 counts as "answered without auth".

- [ ] **Step 2: Watch them fail.** **Step 3: Implement.** Use 2B-1's `service.ts` patterns: `liveSource`, `sourceView` and the SQL counts.

  In `sheets/service.ts`, `integrationsView` gains `webhooks: { enabled: bool, manychat: cfg === "on" }`. `AppDeps` gains `manychatPreset?: boolean`, from `cfg.LUME_MANYCHAT_PRESET === "on"`.

  Audit phrases: `webhook.connected` "connected the webhook “{name}”", `webhook.mapping_changed`, `webhook.paused`, `webhook.resumed`, `webhook.secret_rotated` "gave the webhook “{name}” a new secret", `webhook.removed`, and `integration.enabled`/`integration.disabled` with `d.module === "webhooks"` saying "Webhooks". Update the phrase to name the module from `d.module`.

- [ ] **Step 4: Run the tests** (they pass). **Step 5: Gate, commit.** Message: `feat(api): set up a webhook with a test post and the usual steps; rotate its secret; look after its events`.

---

### Task 6: Web — Webhooks in Settings → Integrations

**Files:**
- Create:
  - `apps/web/src/lib/webhooks/types.ts` and `client.ts`;
  - `apps/web/src/components/integrations/WebhooksCard.tsx`;
  - `apps/web/src/components/webhooks/AddWebhookSheet.tsx`, `WhereFromStep.tsx`, `SecretStep.tsx` and `TestStep.tsx`;
  - `apps/web/src/components/integrations/WebhookDetail.tsx`;
  - `apps/web/src/app/(app)/settings/integrations/webhooks/[id]/page.tsx`;
  - `apps/web/public/brand/zapier.png`, `make.png` and `manychat.png`, with README rows.
- Modify: `Integrations.tsx` (render `WebhooksCard` under the Sheets card), `lib/leads/history.ts` (`p.webhook`)
- Test: `WebhooksCard.test.tsx`, `AddWebhookSheet.test.tsx`, `WebhookDetail.test.tsx`

**Interfaces:**
- `webhooksClient`, with `setEnabled`, `create`, `list`, `get`, `test`, `draft`, `save`, `patch`, `rotate`, `retry`, `dismiss` and `remove`.
- `AddWebhookSheet({ open, sourceId?, onClose })`. Its steps are Where from → Address & secret → Send a test → Columns → Rules → Preview → Save. With `sourceId` (edit), it starts at Columns, drafted from the newest event.

- [ ] **Step 1: Failing tests.**

  `WebhooksCard`:
  - off by default, as one switch;
  - on: it lists webhooks with a health line ("Last post 3 min ago · 12 today · 1 problem");
  - "Add a webhook" opens the sheet;
  - a hidden ManyChat preset isn't offered unless `integrations.webhooks.manychat`.

  `AddWebhookSheet`:
  - choosing Website creates the source and shows the address and the secret **once**, with Copy buttons and "LUME won't show this again. Copy it now.";
  - the JavaScript sample contains the address;
  - Continue shows "Waiting for the first post…" and polls `test` every 2 s (fake timers);
  - when paths arrive, it lists them and enables "Use this post";
  - Columns, Rules and Preview (mocked, as in 2B-1's test) lead to Save with a "Keep the test post as a lead" checkbox, checked by default;
  - `save` is called with `{ importId, keepTest: true }`.

  `WebhookDetail`:
  - health, events, problems with Retry and Dismiss, and rejected counts with the last reason in words ("a bad signature");
  - Rotate asks first, then shows the new secret once;
  - Pause/Resume, Edit fields, and Remove (confirm; "Its leads stay in LUME");
  - a back link to Integrations.

- [ ] **Step 2: Watch them fail.**

- [ ] **Step 3: Implement.** Reuse:
  - 2B-1's Integrations patterns (`integrations.module.css`: card, pills, health `dl`, table, problems, back link);
  - the Import frame (`imports.module.css`) for the sheet, including `COLUMN_CODES` gating;
  - `sheets.module.css` for fields.

  The code sample for Signed:

```js
const body = JSON.stringify({ name, phone, email });
const ts = Math.floor(Date.now() / 1000).toString();
const sig = "sha256=" + (await hmacSha256Hex(SECRET, ts + "." + body)); // on your server, never in the browser
await fetch("<address>", { method: "POST", headers: { "content-type": "application/json", "x-lume-timestamp": ts, "x-lume-signature": sig }, body });
```

  Alongside it, a note: "Sign on your server: a secret in a web page isn't secret."

  The Token sample (ManyChat, when visible) shows the header `X-Lume-Token` and the JSON body of the preset's paths.

  The marks follow 2B's rule: official files only, on white tiles. Fetch `zapier.png`, `make.png` and `manychat.png` from each company's press or brand page. If a file can't be fetched from an official source in this environment, render the preset's name in a neutral tile, and add a `TODO(owner): add the official mark` row to the brand README. Don't draw a lookalike.

- [ ] **Step 4: Run the tests** (they pass). **Step 5: Gate, commit.** Message: `feat(web): Webhooks — an address and a secret shown once, a test post, the usual steps, and a page to look after it`.

---

### Task 7: End to end and acceptance

**Files:**
- Create: `apps/web/e2e/webhooks.spec.ts`, `apps/web/e2e-live/acceptance-2c.mjs`
- Modify: `apps/web/e2e/a11y.spec.ts` (the webhook page), `docs/runbooks/acceptance.md` (a Phase 2C section), `infra/Caddyfile` if needed (Task 5)

- [ ] **Step 1: The e2e spec.**
  - Settings → Integrations: switch Webhooks on, then Add a webhook → Website.
  - Read the address and secret from the page.
  - From the test runner, post a signed test with Node's `crypto` (`signFor`'s algorithm, inline) to `http://127.0.0.1:3100/webhooks/in/<id>`.
  - "Use this post" → Columns → Rules → Preview → Save (keep the test).
  - On Leads, the lead is there, and it glows on the next visit.
  - Post a second enquiry with the same phone: it merges ("Enquired again" in its history).
  - A bad signature is refused, and the webhook page counts it.
  - Screenshots: the Webhooks card and the webhook page, in both themes. Axe on both.

- [ ] **Step 2: The live script** runs the same through Caddy on the dev stack (`https://lume.localhost:8443/webhooks/in/<id>`). Add it to the acceptance chain after `acceptance-2b1.mjs`.

- [ ] **Step 3: Run** the gate, the whole e2e suite (reviewing every new or changed screenshot), and the live chain. **Commit, push, CI.** Message: `test(e2e): webhooks end to end — a signed post becomes a lead, a forged one doesn't`.

---

## Self-review

- **Spec coverage:**

  | Spec | Where |
  |---|---|
  | §2 decisions | Tasks 1–6 |
  | §3 data | Task 1 |
  | §4 receiving, in order | Task 3 |
  | §5 processing | Task 4 |
  | §6 screens | Task 6 |
  | §7 API | Task 5 |
  | §8 testing | Every task's Step 1, and Task 7 |

- **Rulings in this plan:**
  - **R1.** Rate limits are in memory: one API process serves each instance.
  - **R2.** Receiving runs outside the request transaction (`db:false`), on the app pool, as the setup status route does (the 2A pool-deadlock lesson).
  - **R3.** A `needs_attention` source keeps accepting posts, and they wait queued (spec §5). A `paused` source answers 503 so senders retry later.
- **Type consistency:** `WebhookConfig`, `Preset` and `WebhookView` carry the same names across Tasks 2–6, and `processEvent`'s origin payload matches `history.ts`'s `p.webhook`.
