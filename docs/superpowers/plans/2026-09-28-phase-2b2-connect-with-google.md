# Phase 2B-2 — "Connect with Google", behind its switch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin connects a Google Sheet by signing in to Google and picking the sheet in Google's own Picker. This needs no service account and no sharing step. It is built now and stays invisible until the owner turns it on after Google verifies LUME.

**Architecture:**
- Every client runs on its own domain, so Google talks to **one relay** the owner hosts (`apps/connect`, at `connect.lumecrm.in`). The relay:
  - holds the OAuth client secret and the Picker key;
  - runs the consent and the Picker;
  - hands the tokens back to the instance, sealed with that instance's own relay token, through a GET redirect.
- **The instance:**
  - stores the refresh token encrypted in the source's config (`auth: "oauth"`);
  - refreshes access tokens through the relay's `/refresh`;
  - passes no lead data through the relay, ever.
- **The Google client** takes a token source. The service-account client and the OAuth client share every read.

**Tech Stack:** Node 22 `node:http` for the relay (no framework, since it is tiny and stateless), `node:crypto` (HMAC-SHA256, AES-256-GCM, HKDF), Fastify for the instance routes, and Next.js for the screens.

**Spec:** `docs/superpowers/specs/2026-09-27-phase-2b-google-sheets-design.md` §6 and amendments A1–A13. Built on plan 2B-1 (`docs/superpowers/plans/2026-09-27-phase-2b1-sheets-refresh.md`).

## Global Constraints

- **Off unless configured.**
  - "Connect with Google" shows only when the instance has `GOOGLE_OAUTH_RELAY_URL` and `GOOGLE_OAUTH_RELAY_TOKEN`.
  - Until then, nothing about it is visible, and the service-account path is unchanged.
  - When both paths are available, "Connect with Google" is the first choice and the service account moves under "Other ways" (spec §6).
- **Least permission:** the scope is `https://www.googleapis.com/auth/drive.file` only, with the Google Picker. LUME can open only the files the admin picks.
- **Secrets:**
  - The OAuth client secret and the Picker API key exist **only on the relay**.
  - The instance's relay token exists only in the instance's env and the relay's instance list.
  - Refresh tokens are sealed in transit (AES-256-GCM under a key derived from the instance's relay token) and encrypted at rest (keyring, bound to the source id).
- **The relay never sees lead data:** only OAuth tokens and the picked file's id and name.
- Sign-in to LUME stays email + password + authenticator. Google is for connecting sheets only.
- **The official Google "G"** (`/brand/google-g.png`) goes on the Connect button, per Google's branding guidelines, on a white surface in both themes.
- **Copy** speaks as "LUME". No sound.
- **Gate, commits, pushes and test commands** are as in plan 2B-1:
  - root `pnpm exec vitest run <path>`, and web tests from `apps/web`;
  - `GATE_OK` before every commit;
  - the commit trailer.

## Review Focus

1. **A forged or replayed callback:**
   - A tampered payload fails its signature, and so does a payload for another instance.
   - An expired one (over 10 minutes) is refused.
   - A payload used a second time is refused: the nonce is single-use and bound to the user who started it.

   *Test: Task 2 protocol cases, and Task 4 "complete refuses…".*
2. **The relay as an open redirect:** it only ever redirects to the URL registered for the instance whose token signed the request, never to a URL taken from the request. *Test: Task 3 "start refuses an unknown instance or a bad signature".*
3. **A refresh token revoked at Google:** the source becomes needs-attention with ACCESS_LOST and a "Connect again" path, not a crash loop. *Test: Task 4 "a revoked grant pauses the sheet".*
4. **Both paths configured:** a service-account source keeps syncing with the service account, and an OAuth source with its own grant; neither borrows the other's credentials. *Test: Task 4 "each source reads with its own credentials".*
5. **The relay is down while an OAuth sheet syncs:** this is a passing failure with backoff; the sheet stays active. *Test: Task 4 "relay unreachable is transient".*

---

### Task 1: Configuration, data, and the relay protocol

**Files:**
- Modify: `packages/config/src/schema.ts` and `config.test.ts`: `GOOGLE_OAUTH_RELAY_URL` and `GOOGLE_OAUTH_RELAY_TOKEN`.
- Create: `packages/db/migrations/0018_oauth_connects.sql`.
- Modify: `packages/db/src/schema/intake.ts` (`oauthConnects`) and `packages/db/src/intake.test.ts`.
- Create: `packages/core/src/relay/protocol.ts`, `packages/core/src/relay/protocol.test.ts`.
- Modify: `packages/core/src/index.ts` (export it, server-side only; never from `shared`).

**Interfaces:**
- `apiSchema` gains `GOOGLE_OAUTH_RELAY_URL?: string` (https in production, http allowed) and `GOOGLE_OAUTH_RELAY_TOKEN?: string` (at least 32 characters). Either both are set or neither is.
- The table `oauth_connects (id uuid pk, user_id uuid not null, nonce_hash text not null unique, created_at, completed_at, grant_enc bytea, file_id text, file_name text)`.
- From `protocol.ts`:
  - `instanceIdOf(token: string): string`: the first 16 hex characters of the token's sha256.
  - `sign(token: string, data: string): string` and `verify(token: string, data: string, sig: string): boolean`: HMAC-SHA256, base64url, compared in constant time.
  - `seal(token: string, value: unknown): string` and `unseal<T>(token: string, sealed: string): T | null`: AES-256-GCM; the key is HKDF-SHA256(token, salt "lume-relay", info "seal").
  - `type Handoff = { nonce: string; refreshToken: string; file: { id: string; name: string }; exp: number }`

- [ ] **Step 1: Write the failing tests**

`packages/core/src/relay/protocol.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { instanceIdOf, seal, sign, unseal, verify } from "./protocol";

const token = "t".repeat(48);
const other = "o".repeat(48);

describe("the relay protocol (Review Focus 1)", () => {
  it("names an instance by its token without revealing it", () => {
    expect(instanceIdOf(token)).toMatch(/^[0-9a-f]{16}$/);
    expect(instanceIdOf(token)).not.toBe(instanceIdOf(other));
  });
  it("signs and verifies; any change or another token fails", () => {
    const s = sign(token, "nonce-1");
    expect(verify(token, "nonce-1", s)).toBe(true);
    expect(verify(token, "nonce-2", s)).toBe(false);
    expect(verify(other, "nonce-1", s)).toBe(false);
    expect(verify(token, "nonce-1", "garbage")).toBe(false);
  });
  it("seals so only the same token opens it, and tampering is caught", () => {
    const sealed = seal(token, { refreshToken: "rt-123", n: 1 });
    expect(unseal(token, sealed)).toEqual({ refreshToken: "rt-123", n: 1 });
    expect(unseal(other, sealed)).toBeNull();
    const flipped = sealed.slice(0, -2) + (sealed.endsWith("A") ? "B" : "A") + sealed.slice(-1);
    expect(unseal(token, flipped)).toBeNull();
    expect(unseal(token, "not-sealed")).toBeNull();
  });
});
```

Append to `packages/db/src/intake.test.ts`:

```ts
describe("0018_oauth_connects", () => {
  it("keeps one pending connect per nonce, and the worker can't read it", async () => {
    await query(
      "lume_owner",
      "INSERT INTO users (id, email, name, status) VALUES ('00000000-0000-7000-8000-00000000c0c0', 'c@x.test', 'C', 'active')",
    );
    await query(
      "lume_owner",
      "INSERT INTO oauth_connects (id, user_id, nonce_hash) VALUES ('00000000-0000-7000-8000-00000000c0c1', '00000000-0000-7000-8000-00000000c0c0', 'h1')",
    );
    await expect(
      query(
        "lume_owner",
        "INSERT INTO oauth_connects (id, user_id, nonce_hash) VALUES ('00000000-0000-7000-8000-00000000c0c2', '00000000-0000-7000-8000-00000000c0c0', 'h1')",
      ),
    ).rejects.toThrow(/oauth_connects_nonce/);
    await expect(query("lume_worker", "SELECT grant_enc FROM oauth_connects")).rejects.toThrow(/permission/);
  });
});
```

Add to `config.test.ts`:

```ts
  it("Connect with Google needs both the relay's address and this instance's token", () => {
    expect(loadConfig(apiSchema, apiEnv).GOOGLE_OAUTH_RELAY_URL).toBeUndefined();
    const ok = loadConfig(apiSchema, { ...apiEnv, GOOGLE_OAUTH_RELAY_URL: "https://connect.lumecrm.in", GOOGLE_OAUTH_RELAY_TOKEN: "x".repeat(40) });
    expect(ok.GOOGLE_OAUTH_RELAY_URL).toBe("https://connect.lumecrm.in");
    expect(issuesOf(() => loadConfig(apiSchema, { ...apiEnv, GOOGLE_OAUTH_RELAY_URL: "https://connect.lumecrm.in" })).join()).toMatch(/GOOGLE_OAUTH_RELAY_TOKEN/);
    expect(issuesOf(() => loadConfig(apiSchema, { ...apiEnv, GOOGLE_OAUTH_RELAY_URL: "https://c.test", GOOGLE_OAUTH_RELAY_TOKEN: "short" })).join()).toMatch(/GOOGLE_OAUTH_RELAY_TOKEN/);
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bash scripts/dev.sh run bash -c 'pnpm exec vitest run packages/core/src/relay packages/db/src/intake.test.ts packages/config'`
Expected: FAIL (the modules, columns and variables don't exist yet).

- [ ] **Step 3: Implement**

`packages/core/src/relay/protocol.ts`:

```ts
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/** What the relay hands back to an instance, sealed with that instance's token (2B spec §6). */
export type Handoff = { nonce: string; refreshToken: string; file: { id: string; name: string }; exp: number };

/** An instance's public name at the relay: a prefix of its token's hash, never the token. */
export const instanceIdOf = (token: string): string => createHash("sha256").update(token).digest("hex").slice(0, 16);

export const sign = (token: string, data: string): string => createHmac("sha256", token).update(data).digest("base64url");

export function verify(token: string, data: string, sig: string): boolean {
  const want = Buffer.from(sign(token, data));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

const keyOf = (token: string) => Buffer.from(hkdfSync("sha256", token, "lume-relay", "seal", 32));

/** AES-256-GCM: iv(12) ‖ tag(16) ‖ ciphertext, base64url. Only the same token opens it; tampering fails. */
export function seal(token: string, value: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(token), iv);
  const body = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
}

export function unseal<T>(token: string, sealed: string): T | null {
  try {
    const raw = Buffer.from(sealed, "base64url");
    if (raw.length < 29) return null;
    const d = createDecipheriv("aes-256-gcm", keyOf(token), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8")) as T;
  } catch {
    return null;
  }
}
```

In `packages/core/src/index.ts`, add `export * from "./relay/protocol";`. It must not be added to `shared.ts`, because it uses `node:crypto`.

`packages/db/migrations/0018_oauth_connects.sql`:

```sql
-- Phase 2B-2 (spec 2B §6): a "Connect with Google" in progress. The nonce is single-use and bound to the
-- person who started it; the grant (the sealed refresh token) waits here until a sheet is made from it.
CREATE TABLE oauth_connects (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  nonce_hash text NOT NULL CONSTRAINT oauth_connects_nonce UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  grant_enc bytea,
  file_id text,
  file_name text
);
REVOKE ALL ON oauth_connects FROM lume_worker;
GRANT SELECT (id, created_at), DELETE ON oauth_connects TO lume_worker;
```

Add to `packages/db/src/schema/intake.ts`:

```ts
/** A "Connect with Google" in progress or just finished (2B §6); swept after a day. */
export const oauthConnects = pgTable("oauth_connects", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  nonceHash: text("nonce_hash").notNull().unique("oauth_connects_nonce"),
  createdAt: tz("created_at").notNull().defaultNow(),
  completedAt: tz("completed_at"),
  grantEnc: bytea("grant_enc"),
  fileId: text("file_id"),
  fileName: text("file_name"),
});
```

In `apps/worker/src/maintenance.ts` `purgeSheetSyncs`, also run `DELETE FROM oauth_connects WHERE created_at < $1` with a 1-day cutoff, and return `connects` in its result (update the type, the test and the boss test's mock).

`packages/config/src/schema.ts` (in `apiSchema`, after `LUME_SHEETS_MAX_ROWS`):

```ts
  /** "Connect with Google" (2B §6): the owner's relay, and this instance's own token there. Unset: hidden. */
  GOOGLE_OAUTH_RELAY_URL: optional(z.url({ protocol: /^https?$/ })),
  GOOGLE_OAUTH_RELAY_TOKEN: optional(z.string().min(32).max(200)),
```

Then, on the object, add a `.superRefine` that reports `GOOGLE_OAUTH_RELAY_TOKEN` when exactly one of the two is set. Follow how the schema file already cross-checks fields; if it has no such check, chain `.superRefine((c, ctx) => { if (!!c.GOOGLE_OAUTH_RELAY_URL !== !!c.GOOGLE_OAUTH_RELAY_TOKEN) ctx.addIssue({ code: "custom", path: ["GOOGLE_OAUTH_RELAY_TOKEN"], message: "set both GOOGLE_OAUTH_RELAY_URL and GOOGLE_OAUTH_RELAY_TOKEN, or neither" }); })` onto `apiSchema`. Check that `loadConfig` still accepts a refined schema; it takes a `z.ZodType`.

- [ ] **Step 4: Run the tests.** Use the Step 2 command, plus `apps/worker`. Expected: PASS, including the schema drift test.

- [ ] **Step 5: Gate and commit**

Message: `feat: the relay protocol for Connect with Google — signed, sealed, single-use — and where a connect waits`, with the trailer.

---

### Task 2: The relay (`apps/connect`)

**Files:**
- Create: `apps/connect/package.json`, `apps/connect/tsconfig.json`, `apps/connect/src/relay.ts`, `apps/connect/src/main.ts`, `apps/connect/src/picker.html.ts`, `apps/connect/src/relay.test.ts`, `apps/connect/Dockerfile`, `apps/connect/README.md`
- Modify: `apps/api/test/google-fake.ts` (the token endpoint also takes `authorization_code` and `refresh_token` grants)

**Interfaces:**
- `createRelay(o: RelayConfig): http.RequestListener`, where

  ```ts
  type RelayConfig = {
    publicUrl: string;
    clientId: string;
    clientSecret: string;
    pickerKey: string;
    appId: string;
    secret: string; // signs the state
    instances: { url: string; token: string }[];
    googleAuthUrl?: string;
    googleTokenUrl?: string;
    now?: () => number;
  }
  ```

- Routes:

  | Route | What it does |
  |---|---|
  | `GET /healthz` | Liveness |
  | `GET /start?i=<instanceId>&n=<nonce>&s=<sig>` | 302 to Google consent |
  | `GET /callback?code&state` | 200, the Picker page |
  | `POST /done` (form: `state`, `file_id`, `file_name`, `code_token`) | 302 to `<instance>/settings/integrations/connected?p=<sealed>&s=<sig>` |
  | `POST /refresh` (bearer instance token, json `{ refreshToken }`) | `{ accessToken, expiresIn }` or 401/400 |

- The Handoff `exp` is now plus 10 minutes. `p` is `seal(instanceToken, Handoff)` and `s` is `sign(instanceToken, p)`.

- [ ] **Step 1: Extend the fake Google token endpoint.** In `google-fake.ts`'s `/token` handler, before the JWT branch:

```ts
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        if (form.get("code") !== "good-code") return send(res, 400, { error: "invalid_grant" });
        const token = randomBytes(16).toString("hex");
        tokens.add(token);
        return send(res, 200, { access_token: token, refresh_token: "rt-good", expires_in: 3600, token_type: "Bearer" });
      }
      if (grant === "refresh_token") {
        if (form.get("refresh_token") !== "rt-good" || revoked) return send(res, 400, { error: "invalid_grant" });
        const token = randomBytes(16).toString("hex");
        tokens.add(token);
        return send(res, 200, { access_token: token, expires_in: 3600, token_type: "Bearer" });
      }
```

Add a `revoked` flag, with `revokeGrant()` and `restoreGrant()` on `GoogleFake`. OAuth-granted tokens can read every sheet the fake holds: `drive.file` lets the picked file through, and the fake doesn't model picking. Mark OAuth tokens in a second set, `oauthTokens`. The access check then passes for them regardless of `sharedWith`.

- [ ] **Step 2: Write the failing tests** `apps/connect/src/relay.test.ts`

```ts
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instanceIdOf, sign, unseal, verify, type Handoff } from "@lume/core";
import { startGoogleFake, type GoogleFake } from "../../api/test/google-fake";
import { createRelay } from "./relay";

const TOKEN = "i".repeat(40);
let fake: GoogleFake;
let base: string;
let server: http.Server;
const get = (path: string) => fetch(`${base}${path}`, { redirect: "manual" });

beforeAll(async () => {
  fake = await startGoogleFake();
  server = http.createServer(
    createRelay({
      publicUrl: "http://relay.test",
      clientId: "cid",
      clientSecret: "csecret",
      pickerKey: "pkey",
      appId: "123",
      secret: "s".repeat(40),
      instances: [{ url: "https://client-a.example", token: TOKEN }],
      googleAuthUrl: "https://accounts.google.test/o/oauth2/v2/auth",
      googleTokenUrl: `${fake.url}/token`,
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await fake.close();
});

describe("the relay", () => {
  it("Review Focus 2: start refuses an unknown instance or a bad signature, and never redirects elsewhere", async () => {
    expect((await get(`/start?i=ffffffffffffffff&n=abc&s=${sign(TOKEN, "abc")}`)).status).toBe(400);
    expect((await get(`/start?i=${instanceIdOf(TOKEN)}&n=abc&s=wrong`)).status).toBe(400);
  });

  it("start sends the browser to Google asking only for drive.file, with a state only the relay can make", async () => {
    const r = await get(`/start?i=${instanceIdOf(TOKEN)}&n=abc&s=${sign(TOKEN, "abc")}`);
    expect(r.status).toBe(302);
    const to = new URL(r.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://accounts.google.test/o/oauth2/v2/auth");
    expect(to.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(to.searchParams.get("access_type")).toBe("offline");
    expect(to.searchParams.get("redirect_uri")).toBe("http://relay.test/callback");
    expect(to.searchParams.get("state")).toBeTruthy();
  });

  it("callback exchanges the code and shows the Picker; done hands back a sealed grant to that instance only", async () => {
    const start = await get(`/start?i=${instanceIdOf(TOKEN)}&n=nonce-9&s=${sign(TOKEN, "nonce-9")}`);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const page = await get(`/callback?code=good-code&state=${encodeURIComponent(state)}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("https://apis.google.com/js/api.js");
    expect(html).toContain('"pkey"');
    const codeToken = /name="code_token" value="([^"]+)"/.exec(html)![1]!;
    const done = await fetch(`${base}/done`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ state, code_token: codeToken, file_id: "sheet-1", file_name: "Leads" }),
    });
    expect(done.status).toBe(302);
    const back = new URL(done.headers.get("location")!);
    expect(back.origin + back.pathname).toBe("https://client-a.example/settings/integrations/connected");
    const p = back.searchParams.get("p")!;
    expect(verify(TOKEN, p, back.searchParams.get("s")!)).toBe(true);
    const h = unseal<Handoff>(TOKEN, p)!;
    expect(h).toMatchObject({ nonce: "nonce-9", refreshToken: "rt-good", file: { id: "sheet-1", name: "Leads" } });
  });

  it("a bad code or a tampered state gets a plain error page, not a redirect", async () => {
    const start = await get(`/start?i=${instanceIdOf(TOKEN)}&n=n2&s=${sign(TOKEN, "n2")}`);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    expect((await get(`/callback?code=bad&state=${encodeURIComponent(state)}`)).status).toBe(400);
    expect((await get(`/callback?code=good-code&state=${encodeURIComponent(state + "x")}`)).status).toBe(400);
  });

  it("refresh gives a new access token to the instance that owns the grant, and refuses strangers", async () => {
    const ok = await fetch(`${base}/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "rt-good" }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ accessToken: expect.any(String), expiresIn: 3600 });
    const stranger = await fetch(`${base}/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${"z".repeat(40)}`, "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "rt-good" }),
    });
    expect(stranger.status).toBe(401);
    fake.revokeGrant();
    const revoked = await fetch(`${base}/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "rt-good" }),
    });
    expect(revoked.status).toBe(400);
    expect((await revoked.json()).error).toBe("revoked");
    fake.restoreGrant();
  });
});
```

- [ ] **Step 3: Run it and watch it fail.** Run `bash scripts/dev.sh run bash -c 'pnpm exec vitest run apps/connect'`. Expected: FAIL (no module). Add `apps/connect` to the vitest projects glob only if `apps/*` doesn't already cover it; it does.

- [ ] **Step 4: Implement** `apps/connect/src/relay.ts`

```ts
import { randomBytes } from "node:crypto";
import type http from "node:http";
import { instanceIdOf, seal, sign, verify, type Handoff } from "@lume/core";
import { pickerPage } from "./picker.html";

export type RelayConfig = {
  publicUrl: string;
  clientId: string;
  clientSecret: string;
  pickerKey: string;
  appId: string;
  /** Signs the OAuth state, so only this relay can make one. */
  secret: string;
  instances: { url: string; token: string }[];
  googleAuthUrl?: string;
  googleTokenUrl?: string;
  now?: () => number;
};

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const TEN_MIN = 10 * 60_000;
type State = { i: string; n: string; exp: number };

/**
 * The relay (2B spec §6): the one place Google calls back to, for every LUME instance. It holds the OAuth
 * client secret and the Picker key; it hands each instance its grant sealed with that instance's token,
 * and only ever redirects to the URL registered for it. It never sees lead data.
 */
export function createRelay(o: RelayConfig): http.RequestListener {
  const now = o.now ?? Date.now;
  const authUrl = o.googleAuthUrl ?? "https://accounts.google.com/o/oauth2/v2/auth";
  const tokenUrl = o.googleTokenUrl ?? "https://oauth2.googleapis.com/token";
  const byId = new Map(o.instances.map((x) => [instanceIdOf(x.token), x]));
  const byToken = new Map(o.instances.map((x) => [x.token, x]));
  const redirectUri = `${o.publicUrl}/callback`;

  const packState = (s: State) => {
    const body = Buffer.from(JSON.stringify(s)).toString("base64url");
    return `${body}.${sign(o.secret, body)}`;
  };
  const readState = (raw: string | null): State | null => {
    if (!raw) return null;
    const [body, sig] = raw.split(".");
    if (!body || !sig || !verify(o.secret, body, sig)) return null;
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as State;
    return s.exp > now() && byId.has(s.i) ? s : null;
  };
  const plain = (res: http.ServerResponse, status: number, text: string) => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(text);
  };
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const body = (req: http.IncomingMessage) =>
    new Promise<string>((resolve) => {
      let b = "";
      req.on("data", (c: Buffer) => {
        if (b.length < 20_000) b += c.toString("utf8");
      });
      req.on("end", () => resolve(b));
    });
  // Code tokens: one-time, short-lived, in memory — they only bridge the Picker page to /done.
  const pending = new Map<string, { refreshToken: string; accessToken: string; state: string; exp: number }>();

  async function exchange(params: Record<string, string>) {
    const r = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: o.clientId, client_secret: o.clientSecret, ...params }),
    });
    return { status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  }

  return (req, res) => {
    void (async () => {
      const u = new URL(req.url ?? "/", o.publicUrl);
      if (u.pathname === "/healthz") return json(res, 200, { status: "ok" });

      if (u.pathname === "/start" && req.method === "GET") {
        const id = u.searchParams.get("i") ?? "";
        const n = u.searchParams.get("n") ?? "";
        const inst = byId.get(id);
        if (!inst || !n || !verify(inst.token, n, u.searchParams.get("s") ?? ""))
          return plain(res, 400, "This link isn't valid. Go back to LUME and try again.");
        const to = new URL(authUrl);
        to.search = new URLSearchParams({
          client_id: o.clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: SCOPE,
          access_type: "offline",
          prompt: "consent",
          include_granted_scopes: "false",
          state: packState({ i: id, n, exp: now() + TEN_MIN }),
        }).toString();
        res.writeHead(302, { location: to.toString(), "cache-control": "no-store" });
        return res.end();
      }

      if (u.pathname === "/callback" && req.method === "GET") {
        const raw = u.searchParams.get("state");
        const state = readState(raw);
        const code = u.searchParams.get("code");
        if (!state || !code) return plain(res, 400, "This sign-in expired or isn't valid. Go back to LUME and try again.");
        const t = await exchange({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
        const refreshToken = t.data.refresh_token as string | undefined;
        const accessToken = t.data.access_token as string | undefined;
        if (t.status !== 200 || !refreshToken || !accessToken)
          return plain(res, 400, "Google didn't give LUME access. Go back to LUME and try again.");
        const codeToken = randomBytes(24).toString("base64url");
        pending.set(codeToken, { refreshToken, accessToken, state: raw!, exp: now() + TEN_MIN });
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'self'; script-src 'self' 'unsafe-inline' https://apis.google.com https://*.googleapis.com; frame-src https://docs.google.com https://*.google.com; connect-src https://*.googleapis.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:",
        });
        return res.end(pickerPage({ accessToken, pickerKey: o.pickerKey, appId: o.appId, state: raw!, codeToken }));
      }

      if (u.pathname === "/done" && req.method === "POST") {
        const f = new URLSearchParams(await body(req));
        const state = readState(f.get("state"));
        const p = pending.get(f.get("code_token") ?? "");
        pending.delete(f.get("code_token") ?? "");
        const fileId = f.get("file_id") ?? "";
        if (!state || !p || p.state !== f.get("state") || p.exp < now() || !/^[A-Za-z0-9_-]{10,}$/.test(fileId))
          return plain(res, 400, "This sign-in expired or isn't valid. Go back to LUME and try again.");
        const inst = byId.get(state.i)!;
        const handoff: Handoff = {
          nonce: state.n,
          refreshToken: p.refreshToken,
          file: { id: fileId, name: (f.get("file_name") ?? "").slice(0, 200) },
          exp: now() + TEN_MIN,
        };
        const sealed = seal(inst.token, handoff);
        const back = new URL("/settings/integrations/connected", inst.url);
        back.search = new URLSearchParams({ p: sealed, s: sign(inst.token, sealed) }).toString();
        res.writeHead(302, { location: back.toString(), "cache-control": "no-store" });
        return res.end();
      }

      if (u.pathname === "/refresh" && req.method === "POST") {
        const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        if (!byToken.has(token)) return json(res, 401, { error: "unknown_instance" });
        const { refreshToken } = JSON.parse((await body(req)) || "{}") as { refreshToken?: string };
        if (!refreshToken) return json(res, 400, { error: "bad_request" });
        const t = await exchange({ grant_type: "refresh_token", refresh_token: refreshToken });
        if (t.status === 400 && t.data.error === "invalid_grant") return json(res, 400, { error: "revoked" });
        if (t.status !== 200) return json(res, 502, { error: "google_unavailable" });
        return json(res, 200, { accessToken: t.data.access_token, expiresIn: t.data.expires_in });
      }

      return plain(res, 404, "Not found");
    })().catch(() => plain(res, 500, "Something went wrong. Go back to LUME and try again."));
  };
}
```

`apps/connect/src/picker.html.ts`: the Picker page. It loads `https://apis.google.com/js/api.js`, then `gapi.load("picker")`, and builds a `google.picker.PickerBuilder()` with:
- `.addView(new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS).setSelectFolderEnabled(false))`
- `.setOAuthToken(accessToken)`, `.setDeveloperKey(pickerKey)`, `.setAppId(appId)`
- a callback that, on `PICKED`, fills and submits a hidden form (`POST /done` with `state`, `code_token`, `file_id`, `file_name`);
- on `CANCEL`, it shows "Nothing was picked. You can close this tab and go back to LUME."

Every value is JSON-encoded into the page with `JSON.stringify(...).replace(/</g, "\\u003c")`, so nothing breaks out of the script. The page shows the LUME wordmark text and "Pick the sheet LUME should read". It never shows the `code_token` anywhere visible.

```ts
const js = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

export function pickerPage(o: { accessToken: string; pickerKey: string; appId: string; state: string; codeToken: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pick a sheet · LUME</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#eef0f3;color:#0a0c11}
main{background:#fff;border-radius:16px;padding:28px 32px;box-shadow:0 0 0 .5px rgba(12,18,32,.1),0 18px 50px rgba(12,18,32,.12);max-width:420px;text-align:center}
h1{font-size:18px;margin:0 0 6px}p{color:#5a606d;margin:0}</style></head>
<body><main><h1>Pick the sheet LUME should read</h1><p id="msg">Google's picker is opening…</p>
<form id="f" method="post" action="/done" hidden>
<input type="hidden" name="state" value="${o.state.replace(/"/g, "&quot;")}">
<input type="hidden" name="code_token" value="${o.codeToken}">
<input type="hidden" name="file_id"><input type="hidden" name="file_name"></form></main>
<script>
const cfg = { token: ${js(o.accessToken)}, key: ${js(o.pickerKey)}, app: ${js(o.appId)} };
function done(data) {
  if (data.action === google.picker.Action.PICKED) {
    const d = data.docs[0];
    const f = document.getElementById("f");
    f.file_id.value = d.id; f.file_name.value = d.name;
    document.getElementById("msg").textContent = "Connecting…";
    f.submit();
  } else if (data.action === google.picker.Action.CANCEL) {
    document.getElementById("msg").textContent = "Nothing was picked. You can close this tab and go back to LUME.";
  }
}
function open() {
  new google.picker.PickerBuilder()
    .addView(new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS).setSelectFolderEnabled(false))
    .setOAuthToken(cfg.token).setDeveloperKey(cfg.key).setAppId(cfg.app)
    .setCallback(done).build().setVisible(true);
}
</script>
<script src="https://apis.google.com/js/api.js" onload="gapi.load('picker', open)"></script>
</body></html>`;
}
```

`apps/connect/src/main.ts` reads its env and listens:
- `RELAY_PUBLIC_URL`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_PICKER_API_KEY`, `GOOGLE_PROJECT_NUMBER`;
- `RELAY_SECRET` (at least 32 characters);
- `RELAY_INSTANCES` (JSON `[{ "url", "token" }]`);
- `PORT` (default 3200).

It validates them with zod and exits with a clear message when one is missing.

`apps/connect/package.json`:
- name `@lume/connect`, `type: module`;
- depends on `@lume/core` and `zod`;
- scripts: `typecheck` (`tsc -p tsconfig.json`) and `build` (`node ../../scripts/bundle.mjs . src/main.ts dist/main.js`).

Copy `tsconfig.json` from `apps/worker`. The `Dockerfile` is a two-line node:22-slim that copies `dist/main.js` and runs it.

`apps/connect/README.md` gives the owner's setup:
- a Google Cloud project;
- an OAuth consent screen (external) with the `drive.file` scope, and verification;
- an OAuth client (web), with the redirect URI `https://connect.lumecrm.in/callback`;
- the Picker API enabled, and an API key restricted to the Picker API and the relay's origin;
- the project number as `GOOGLE_PROJECT_NUMBER`;
- one `RELAY_INSTANCES` entry per client, whose token also goes into that client's `.env` as `GOOGLE_OAUTH_RELAY_TOKEN`.

Run `bash scripts/dev.sh run pnpm install --lockfile-only` through `dev.sh add` if the new workspace package needs the lockfile updated (`bash scripts/dev.sh add --filter @lume/connect zod @lume/core@workspace:*`).

- [ ] **Step 5: Run the tests.** Run `bash scripts/dev.sh run bash -c 'pnpm exec vitest run apps/connect apps/api/src/modules/sheets/google.test.ts'`. Expected: PASS.

- [ ] **Step 6: Gate and commit**

Message: `feat(connect): the relay for Connect with Google — consent, Google's Picker, and a sealed hand-back to the one instance that asked`, with the trailer.

---

### Task 3: The instance reads with either credential

**Files:**
- Modify:
  - `apps/api/src/modules/sheets/google.ts`: token sources.
  - `apps/api/src/modules/sheets/config.ts`: `auth: "oauth"`, with the grant.
  - `apps/api/src/modules/sheets/sync.ts`: a client per source.
  - `apps/api/src/app.ts`: `AppDeps.googleOAuth`.
  - `apps/api/src/main.ts`.
  - `apps/api/test/harness.ts`: `googleOAuth` against the fake relay (the real relay module, in-process).
- Test: `apps/api/src/modules/sheets/oauth.test.ts`

**Interfaces:**
- `google.ts`:
  - `type TokenSource = () => Promise<string>`, and `serviceAccountTokens(o: { account; fetch?; now? }): TokenSource`, which extracts today's JWT exchange.
  - `relayTokens(o: { relayUrl: string; relayToken: string; refreshToken: string; fetch?; now? }): TokenSource`. It calls `POST {relayUrl}/refresh`. A 400 `revoked` throws `GoogleError("access", "Google access for this sheet was removed. Connect it again.")`. Network errors and 5xx throw `GoogleError("unavailable", …)`.
  - `createGoogleSheets(o: { tokens: TokenSource; email: string; endpoint?; fetch?; sleep? })`: the same reads as today. `parseServiceAccount` stays.
- `SheetConfig` gains `auth: "service_account" | "oauth"` and `grant?: string` (the refresh token; it lives only inside `config_enc`).
- `SyncDeps.google: GoogleSheets | null`; `SyncDeps.clientFor?: (cfg: SheetConfig) => GoogleSheets | null`. `runSync` uses `clientFor(cfg) ?? o.google`, and a source with no usable client is `Attention("ACCESS_LOST", "Connect this sheet again.")`.
- `AppDeps.googleOAuth?: { relayUrl: string; relayToken: string } | null`.

- [ ] **Step 1: Write the failing tests** `apps/api/src/modules/sheets/oauth.test.ts`

```ts
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ALL_GRANTS, DEFAULT_RULES, newId } from "@lume/core";
import { schema } from "@lume/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRelay } from "../../../../connect/src/relay";
import { createHarness, type Harness } from "../../../test/harness";
import { sealConfig } from "./config";
import { requestSync } from "./requests";

const RELAY_TOKEN = "r".repeat(40);
let h: Harness;
let relay: http.Server;
let adminId: string;

beforeAll(async () => {
  h = await createHarness({ preset: "general", google: true, oauth: { relayToken: RELAY_TOKEN } });
  relay = http.createServer(
    createRelay({
      publicUrl: "http://relay.test",
      clientId: "cid",
      clientSecret: "cs",
      pickerKey: "pk",
      appId: "1",
      secret: "s".repeat(40),
      instances: [{ url: "https://lume.test", token: RELAY_TOKEN }],
      googleTokenUrl: `${h.fake!.url}/token`,
    }),
  );
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  h.setRelayUrl(`http://127.0.0.1:${(relay.address() as AddressInfo).port}`);
  adminId = (await h.seedUser({ grants: ALL_GRANTS, totp: true })).id;
});
afterAll(async () => {
  relay.close();
  await h.close();
});

async function source(auth: "service_account" | "oauth", shared: boolean) {
  const spreadsheetId = `ss-${newId()}`;
  h.fake!.put(spreadsheetId, {
    title: "S",
    sharedWith: shared ? [h.fake!.email] : [],
    tabs: [{ sheetId: 0, title: "T", rows: [["Name", "Phone"], ["OAuth Lead " + auth, "0507123" + (auth === "oauth" ? "001" : "002")]] }],
  });
  const pipelineId = (await h.queryAll<{ id: string }>("SELECT id FROM pipelines WHERE is_default"))[0]!.id;
  const stageId = (await h.queryAll<{ id: string }>("SELECT id FROM stages WHERE pipeline_id = $1 AND kind = 'open' ORDER BY position LIMIT 1", [pipelineId]))[0]!.id;
  const id = newId();
  await h.pool.query(
    `INSERT INTO lead_sources (id, type, name, status, config_enc, mapping, rules, headers, run_as)
     VALUES ($1, 'google_sheet', 'S', 'active', $2, $3, $4, '["Name","Phone"]', $5)`,
    [
      id,
      sealConfig(h.keyring, id, { spreadsheetId, sheetId: 0, tabTitle: "T", headerRow: 1, auth, ...(auth === "oauth" ? { grant: "rt-good" } : {}) }),
      { columns: [{ column: 0, to: "field", field: "name" }, { column: 1, to: "field", field: "phone" }], createMissingTags: false },
      DEFAULT_RULES({ pipelineId, stageId, country: "AE" }),
      adminId,
    ],
  );
  return id;
}
const sync = async (sourceId: string) => {
  const r = await drizzle(h.pool, { schema }).transaction((tx) => requestSync(tx, { sourceId, trigger: "manual", requestedBy: null }));
  await h.runSyncs([r!.syncId]);
  return (await h.pool.query("SELECT status, attention_code FROM lead_sources WHERE id = $1", [sourceId])).rows[0];
};

describe("reading with either credential (Review Focus 4)", () => {
  it("each source reads with its own credentials", async () => {
    const oauth = await source("oauth", false); // not shared with the service account: only the grant can read it
    const sa = await source("service_account", true);
    expect(await sync(oauth)).toMatchObject({ status: "active" });
    expect(await sync(sa)).toMatchObject({ status: "active" });
    expect(await h.queryAll("SELECT 1 FROM leads WHERE name LIKE 'OAuth Lead %'")).toHaveLength(2);
  });

  it("Review Focus 3: a revoked grant pauses the sheet with a way back", async () => {
    const id = await source("oauth", false);
    h.fake!.revokeGrant();
    expect(await sync(id)).toMatchObject({ status: "needs_attention", attention_code: "ACCESS_LOST" });
    h.fake!.restoreGrant();
  });

  it("Review Focus 5: the relay unreachable is a passing failure", async () => {
    const id = await source("oauth", false);
    h.setRelayUrl("http://127.0.0.1:1"); // nothing listens there
    expect(await sync(id)).toMatchObject({ status: "active" });
    const [s] = (await h.pool.query("SELECT failures FROM lead_sources WHERE id = $1", [id])).rows;
    expect(s.failures).toBe(1);
    h.setRelayUrl(`http://127.0.0.1:${(relay.address() as AddressInfo).port}`);
  });
});
```

The harness gains:
- `oauth?: { relayToken: string }` in its options;
- `setRelayUrl(url)`, which updates a mutable `googleOAuth` object passed to both `buildApp` and `runSync`;
- `runSyncs(ids?: string[])`, which also accepts explicit sync ids (they're queued by the caller's own `requestSync`).

Add these in Step 3.

- [ ] **Step 2: Run it and watch it fail.** Run `bash scripts/dev.sh run bash -c 'pnpm exec vitest run apps/api/src/modules/sheets/oauth.test.ts'`. Expected: FAIL.

- [ ] **Step 3: Implement.**

In `google.ts`, split the token logic out of `createGoogleSheets` unchanged into `serviceAccountTokens`. Add `relayTokens`:

```ts
/** "Connect with Google" (2B §6): access tokens come from the relay, which alone holds the client secret. */
export function relayTokens(o: {
  relayUrl: string;
  relayToken: string;
  refreshToken: string;
  fetch?: typeof fetch;
  now?: () => number;
}): TokenSource {
  const http = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  let token: { value: string; until: number } | null = null;
  return async () => {
    if (token && now() < token.until) return token.value;
    let res: Response;
    try {
      res = await http(`${o.relayUrl}/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${o.relayToken}`, "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: o.refreshToken }),
      });
    } catch {
      throw new GoogleError("unavailable", "LUME couldn't reach its Google connector.");
    }
    const j = (await res.json().catch(() => ({}))) as { accessToken?: string; expiresIn?: number; error?: string };
    if (res.status === 400 && j.error === "revoked")
      throw new GoogleError("access", "Google access for this sheet was removed. Connect it again.");
    if (!res.ok || !j.accessToken) throw new GoogleError("unavailable", "LUME's Google connector didn't answer.");
    token = { value: j.accessToken, until: now() + ((j.expiresIn ?? 3600) - 60) * 1000 };
    return token.value;
  };
}
```

`createGoogleSheets(o: { tokens: TokenSource; email: string; endpoint?; fetch?; sleep? })`:
- replaces `await accessToken()` with `await o.tokens()`, and `token = null` on a 401 with a flag that makes the next `o.tokens()` refresh;
- the simplest way to implement that is `const tokens = o.tokens;` plus a local `force` flag passed through: `TokenSource = (force?: boolean) => Promise<string>`, where both sources honour `force` by skipping their cache.

Update every caller:
- `main.ts`: `createGoogleSheets({ tokens: serviceAccountTokens({ account }), email: account.clientEmail, endpoint })`.
- The harness.
- `google.test.ts`: its setup builds the client the new way; its assertions don't change.

`sync.ts`:
- `SyncDeps` gains `clientFor?: (cfg: SheetConfig) => GoogleSheets | null`.
- `google` becomes `GoogleSheets | null`.
- In `syncSource`, after opening the config:

```ts
  const google = (cfg.auth === "oauth" ? o.clientFor?.(cfg) : o.google) ?? null;
  if (!google) throw new Attention("ACCESS_LOST", "LUME can't read this sheet with the access it has. Connect it again.");
```

Then use `google` everywhere `o.google` was used inside `syncSource` and its helpers. Pass it down to `readSheetRows` and `ask`, and make `changedAt(google, …)` take it too.

`app.ts`: `googleOAuth?: { relayUrl: string; relayToken: string } | null;`.

`main.ts`:
- `const googleOAuth = cfg.GOOGLE_OAUTH_RELAY_URL ? { relayUrl: cfg.GOOGLE_OAUTH_RELAY_URL, relayToken: cfg.GOOGLE_OAUTH_RELAY_TOKEN! } : null;`, passed to `buildApp`.
- `startSheetsQueue` gains `clientFor`, built by a shared helper `oauthClientFor(googleOAuth, endpoint)` in `google.ts`:

```ts
/** A client for one OAuth-connected sheet; null when Connect with Google isn't configured here. */
export const oauthClientFor =
  (oauth: { relayUrl: string; relayToken: string } | null | undefined, endpoint?: string) =>
  (cfg: { grant?: string }): GoogleSheets | null =>
    oauth && cfg.grant
      ? createGoogleSheets({ tokens: relayTokens({ ...oauth, refreshToken: cfg.grant }), email: "", ...(endpoint ? { endpoint } : {}) })
      : null;
```

The sheets queue is started when **either** a service account or `googleOAuth` is configured. `startSheetsQueue`'s `google` becomes nullable.

The harness keeps a mutable `const googleOAuth = opts.oauth ? { relayUrl: "", relayToken: opts.oauth.relayToken } : null;`:
- `setRelayUrl` sets `googleOAuth.relayUrl`;
- `runSync` gets `clientFor: oauthClientFor(googleOAuth, fake?.url)`;
- `buildApp` gets `googleOAuth`.

The fake's OAuth tokens read every sheet (Task 2 Step 1), which is how `drive.file` behaves for a picked file.

- [ ] **Step 4: Run the tests.** Run `bash scripts/dev.sh run bash -c 'pnpm exec vitest run apps/api/src/modules/sheets apps/connect'`. Expected: PASS, with every 2B-1 sheets test unchanged.

- [ ] **Step 5: Gate and commit**

Message: `feat(api): a sheet reads with its own credential — the service account, or its Google grant through the relay`, with the trailer.

---

### Task 4: Connect, complete, and a sheet from the picked file

**Files:**
- Modify:
  - `apps/api/src/modules/sheets/service.ts`: `integrationsView` shows `connectWithGoogle`; `connectStart`, `connectComplete` and `createSheetDraft` from a grant.
  - `apps/api/src/modules/sheets/routes.ts` and `apps/api/test/probes.ts`.
- Test: `apps/api/src/modules/sheets/connect.test.ts`

**Interfaces:**
- `GET /api/v1/integrations` → `googleSheets: { enabled, available, email, connectWithGoogle: boolean }`. `available` is true when either path is configured.
- `POST /api/v1/integrations/google/connect` (`integrations.manage`) → `{ url }`. It records a nonce (its sha256 in `oauth_connects`, bound to the caller).
- `POST /api/v1/integrations/google/complete` (`integrations.manage`, body `{ p, s }`) → `{ connectId, file: { id, name } }`. It:
  - verifies the signature with this instance's relay token;
  - unseals the payload;
  - checks that `exp` hasn't passed and that the nonce's hash exists, belongs to the caller and is unused;
  - stores the refresh token (keyring, context `oauth-connect:<id>`) and the file;
  - marks the connect complete.
- `POST /api/v1/sheets/inspect` also accepts `{ connectId }`, and reads the picked file with its grant.
- `POST /api/v1/sheets/drafts` also accepts `{ connectId, sheetId, headerRow? }`. The draft source's config is `{ auth: "oauth", grant }`, and the grant is copied out of `oauth_connects`, which is then deleted.

- [ ] **Step 1: Write the failing tests** `apps/api/src/modules/sheets/connect.test.ts`

Set up as in `oauth.test.ts` (a harness with `google: true` and `oauth`, and the in-process relay). Then:

```ts
describe("Connect with Google (Review Focus 1)", () => {
  it("is offered only where the relay is configured", async () => {
    expect((await call(admin, "GET", "/api/v1/integrations")).json().googleSheets).toMatchObject({ connectWithGoogle: true, available: true });
    // the bare harness (no oauth, no key) offers nothing
    expect((await call(bareAdmin, "GET", "/api/v1/integrations")).json().googleSheets).toMatchObject({ connectWithGoogle: false, available: false });
  });

  it("start gives a relay link signed for this instance; the relay accepts it", async () => {
    const { url } = (await call(admin, "POST", "/api/v1/integrations/google/connect")).json();
    const u = new URL(url);
    expect(u.origin).toBe(relayOrigin);
    expect(u.searchParams.get("i")).toBe(instanceIdOf(RELAY_TOKEN));
    expect(verify(RELAY_TOKEN, u.searchParams.get("n")!, u.searchParams.get("s")!)).toBe(true);
  });

  it("complete takes a genuine hand-back once, for the person who started it, then makes a sheet from the picked file", async () => {
    const { url } = (await call(admin, "POST", "/api/v1/integrations/google/connect")).json();
    const nonce = new URL(url).searchParams.get("n")!;
    const spreadsheetId = `picked-${newId()}`;
    h.fake!.put(spreadsheetId, { title: "Picked", sharedWith: [], tabs: [{ sheetId: 3, title: "Leads", rows: [["Name", "Phone"], ["Picked One", "0507123999"]] }] });
    const p = seal(RELAY_TOKEN, { nonce, refreshToken: "rt-good", file: { id: spreadsheetId, name: "Picked" }, exp: Date.now() + 60_000 });
    const s = sign(RELAY_TOKEN, p);
    // someone else can't complete it
    expect((await call(otherAdmin, "POST", "/api/v1/integrations/google/complete", { p, s })).json().error.code).toBe("CONNECT_NOT_FOUND");
    const done = (await call(admin, "POST", "/api/v1/integrations/google/complete", { p, s })).json();
    expect(done).toMatchObject({ file: { id: spreadsheetId, name: "Picked" } });
    // not twice
    expect((await call(admin, "POST", "/api/v1/integrations/google/complete", { p, s })).json().error.code).toBe("CONNECT_NOT_FOUND");
    const tabs = (await call(admin, "POST", "/api/v1/sheets/inspect", { connectId: done.connectId })).json();
    expect(tabs).toMatchObject({ title: "Picked", tabs: [{ sheetId: 3, title: "Leads" }] });
    const d = (await call(admin, "POST", "/api/v1/sheets/drafts", { connectId: done.connectId, sheetId: 3 })).json();
    const saved = (await call(admin, "POST", "/api/v1/sheets/sources", { importId: d.draft.id, name: "Picked", pollSeconds: 120, startFrom: "all" })).json();
    await h.runSyncs();
    expect((await call(admin, "GET", `/api/v1/sheets/sources/${saved.id}`)).json()).toMatchObject({ newAllTime: 1 });
    expect(await h.queryAll("SELECT 1 FROM oauth_connects WHERE id = $1", [done.connectId])).toHaveLength(0);
  });

  it("refuses a tampered, foreign or expired hand-back", async () => {
    const { url } = (await call(admin, "POST", "/api/v1/integrations/google/connect")).json();
    const nonce = new URL(url).searchParams.get("n")!;
    const good = seal(RELAY_TOKEN, { nonce, refreshToken: "rt-good", file: { id: "x".repeat(20), name: "X" }, exp: Date.now() + 60_000 });
    expect((await call(admin, "POST", "/api/v1/integrations/google/complete", { p: good, s: "bad" })).json().error.code).toBe("CONNECT_INVALID");
    const foreign = seal("f".repeat(40), { nonce, refreshToken: "rt", file: { id: "x".repeat(20), name: "X" }, exp: Date.now() + 60_000 });
    expect((await call(admin, "POST", "/api/v1/integrations/google/complete", { p: foreign, s: sign("f".repeat(40), foreign) })).json().error.code).toBe("CONNECT_INVALID");
    const old = seal(RELAY_TOKEN, { nonce, refreshToken: "rt", file: { id: "x".repeat(20), name: "X" }, exp: Date.now() - 1 });
    expect((await call(admin, "POST", "/api/v1/integrations/google/complete", { p: old, s: sign(RELAY_TOKEN, old) })).json().error.code).toBe("CONNECT_EXPIRED");
  });
});
```

Declare `call`, `admin`, `otherAdmin`, `bareAdmin` and `relayOrigin` in the file's setup, exactly as `sheets.test.ts` does. Import `instanceIdOf`, `seal`, `sign` and `verify` from `@lume/core`.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement.**

In `service.ts`:
- `integrationsView` returns `connectWithGoogle: !!d.googleOAuth`, and sets `available: !!d.google || !!d.googleOAuth`.
- `requireOn` accepts either path.
- `connectStart(req, d)`:
  - requires `d.googleOAuth` and the module on;
  - generates `nonce = randomBytes(24).toString("base64url")`;
  - inserts `oauth_connects { id: newId(), userId, nonceHash: sha256(nonce) }`;
  - returns `{ url: \`${relayUrl}/start?i=${instanceIdOf(token)}&n=${nonce}&s=${sign(token, nonce)}\` }`.
- `connectComplete(req, d, { p, s })`:
  - `verify(token, p, s)`, else 400 `CONNECT_INVALID` "This connection isn't valid. Try Connect with Google again.";
  - `unseal<Handoff>(token, p)`, else the same;
  - `exp < Date.now()` → 400 `CONNECT_EXPIRED` "This connection took too long. Try Connect with Google again.";
  - find the row by `nonceHash = sha256(nonce)` AND `userId = caller` AND `completedAt IS NULL`, else 404 `CONNECT_NOT_FOUND`;
  - update it with `grantEnc: d.keyring.encrypt(refreshToken, \`oauth-connect:${id}\`)`, `fileId`, `fileName` and `completedAt: now`;
  - audit `sheet.google_connected` (diff `{ file: name }`);
  - return `{ connectId: id, file }`.
- A helper `grantOf(req, d, connectId)`:
  - loads a completed connect of the caller's, else 404;
  - returns `{ refreshToken, fileId, fileName }` and a client from `oauthClientFor(d.googleOAuth, endpoint)({ grant })`.
  - `AppDeps` needs the endpoint for tests: add `googleEndpoint?: string` to `AppDeps`, set from `cfg.LUME_GOOGLE_ENDPOINT` in `main.ts` and from `fake.url` in the harness.
- `inspectSheet(req, d, body: { link } | { connectId })`: with `connectId`, it reads `spreadsheet(fileId)` with the grant's client.
- `createSheetDraft(req, d, body)`: a third branch, `{ connectId, sheetId, headerRow? }`:
  - `cfg = { spreadsheetId: fileId, sheetId, tabTitle: "", headerRow: headerRow ?? 0, auth: "oauth", grant: refreshToken }`;
  - the snapshot uses the grant's client, so pass the `GoogleSheets` into `snapshot()` rather than using `d.google`;
  - after the draft source's config is sealed, `DELETE FROM oauth_connects WHERE id = connectId`.
- `saveSheet` needs no change: the config, grant included, rides along in the draft source's `config_enc`.
- `assertNotConnected` compares `spreadsheetId` and `sheetId` whatever the auth.

`routes.ts`:
- `r.post("/api/v1/integrations/google/connect", { config: manage }, (req) => connectStart(req, d));`
- `r.post("/api/v1/integrations/google/complete", { config: manage, schema: { body: z.object({ p: z.string().max(8000), s: z.string().max(200) }).strict() } }, (req) => connectComplete(req, d, req.body));`
- Widen the inspect body schema to a union: `{ link }` or `{ connectId: z.uuid() }`.
- Widen the drafts union with `{ connectId, sheetId, headerRow? }`.

Probes:

```ts
  "POST /api/v1/integrations/google/connect": { access: "integrations.manage" },
  "POST /api/v1/integrations/google/complete": { access: "integrations.manage", body: () => ({ p: "x", s: "y" }) },
```

Audit wording in `lib/settings/audit.ts`: `"sheet.google_connected": { area: "Leads", phrase: (d) => \`connected Google to pick “${String(d.file ?? "")}”\` },`.

- [ ] **Step 4: Run the tests.** Run `bash scripts/dev.sh run bash -c 'pnpm exec vitest run apps/api/src/modules/sheets apps/api/test'`. Expected: PASS.

- [ ] **Step 5: Gate and commit**

Message: `feat(api): Connect with Google — a signed start, a single-use hand-back, and a sheet from the file you picked`, with the trailer.

---

### Task 5: Web — Connect with Google

**Files:**
- Create: `apps/web/src/app/(app)/settings/integrations/connected/page.tsx`, `apps/web/src/components/integrations/Connected.tsx`
- Modify:
  - `apps/web/src/lib/sheets/types.ts` and `client.ts`: `connectWithGoogle`, `connect()`, `complete()`, `inspect({ connectId })`, `draft({ connectId, sheetId })`.
  - `apps/web/src/components/integrations/Integrations.tsx`: the button, and "Other ways".
  - `apps/web/src/components/sheets/AddSheetSheet.tsx` and `SheetStep.tsx`: start from a picked file.
- Test: `apps/web/src/components/integrations/Connected.test.tsx`, plus additions to `Integrations.test.tsx` and `AddSheetSheet.test.tsx`

**Interfaces:**
- `AddSheetSheet` gains `connect?: { connectId: string; file: { id: string; name: string } }`. With it, the Sheet step opens on that file's tabs (`inspect({ connectId })`), with no link field, and "Continue" drafts with `{ connectId, sheetId }`.
- `Connected()` reads `p` and `s` from the address, calls `complete`, then:
  - on success, shows the Add a sheet wizard with `connect`;
  - on an error, shows the message and a "Try again" button that starts a new connect.

- [ ] **Step 1: Write the failing tests.**

`Integrations.test.tsx` gains:

```tsx
  it("with Google verified, Connect with Google comes first and the service account moves under Other ways", async () => {
    vi.mocked(sheetsClient.integrations).mockResolvedValue(ok({ googleSheets: { ...on.googleSheets, connectWithGoogle: true } }));
    vi.mocked(sheetsClient.list).mockResolvedValue(ok({ sources: [] }));
    vi.mocked(sheetsClient.connect).mockResolvedValue(ok({ url: "https://connect.lumecrm.in/start?i=a&n=b&s=c" }));
    const assign = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, assign }, writable: true });
    render(<Integrations />);
    const connect = await screen.findByRole("button", { name: "Connect with Google" });
    expect(document.querySelector('img[src="/brand/google-g.png"]')).not.toBeNull();
    expect(screen.getByText("Other ways")).toBeInTheDocument();
    await userEvent.click(connect);
    expect(assign).toHaveBeenCalledWith("https://connect.lumecrm.in/start?i=a&n=b&s=c");
  });
```

Add `connect: vi.fn()` to the mock, and add `connectWithGoogle: false` to the existing `on` fixture.

`Connected.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sheetsClient } from "@/lib/sheets/client";
import { Connected } from "./Connected";

const search = new URLSearchParams({ p: "sealed", s: "sig" });
vi.mock("next/navigation", () => ({ useSearchParams: () => search, useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/lib/sheets/client", () => ({ sheetsClient: { complete: vi.fn(), connect: vi.fn() } }));
vi.mock("@/components/sheets/AddSheetSheet", () => ({
  AddSheetSheet: ({ open, connect }: { open: boolean; connect?: { file: { name: string } } }) =>
    open ? <div role="dialog" aria-label="Add a sheet">{connect?.file.name}</div> : null,
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
beforeEach(() => vi.clearAllMocks());

describe("back from Google", () => {
  it("completes the hand-back and opens Add a sheet on the picked file", async () => {
    vi.mocked(sheetsClient.complete).mockResolvedValue(ok({ connectId: "c1", file: { id: "f", name: "Picked leads" } }));
    render(<Connected />);
    expect(sheetsClient.complete).toHaveBeenCalledWith({ p: "sealed", s: "sig" });
    expect(await screen.findByRole("dialog", { name: "Add a sheet" })).toHaveTextContent("Picked leads");
  });
  it("says what went wrong, with a way to try again", async () => {
    vi.mocked(sheetsClient.complete).mockResolvedValue({ ok: false, status: 400, code: "CONNECT_EXPIRED", message: "This connection took too long. Try Connect with Google again." } as never);
    render(<Connected />);
    expect(await screen.findByRole("alert")).toHaveTextContent("took too long");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
```

`AddSheetSheet.test.tsx` gains:

```tsx
  it("from a picked file, it lists that file's tabs — no link to paste", async () => {
    vi.mocked(sheetsClient.inspect).mockResolvedValue(ok({ spreadsheetId: "f", title: "Picked leads", gid: null, tabs: [{ sheetId: 3, title: "Leads" }], email: "" }));
    vi.mocked(sheetsClient.draft).mockResolvedValue({ ...ok(sheetDraft), status: 201 });
    render(<AddSheetSheet open connect={{ connectId: "c1", file: { id: "f", name: "Picked leads" } }} onClose={() => undefined} />);
    expect(screen.queryByLabelText("Sheet link")).toBeNull();
    expect(await screen.findByLabelText("Tab")).toHaveValue("3");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(sheetsClient.inspect).toHaveBeenCalledWith({ connectId: "c1" });
    expect(sheetsClient.draft).toHaveBeenCalledWith({ connectId: "c1", sheetId: 3 });
  });
```

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement.**

`client.ts`:
- `connect: () => api.post<{ url: string }>("/api/v1/integrations/google/connect")`
- `complete: (b: { p: string; s: string }) => api.post<{ connectId: string; file: { id: string; name: string } }>("/api/v1/integrations/google/complete", b)`
- widen `inspect(arg: string | { connectId: string })`, sending `{ link: arg }` for a string;
- widen `draft` with `{ connectId: string; sheetId: number; headerRow?: number }`.

`types.ts`: `IntegrationsView.googleSheets.connectWithGoogle: boolean`.

In `Integrations.tsx`, with `g.connectWithGoogle`, the enabled card shows:

```tsx
            <div className={s.connect}>
              <button type="button" className={s.googleButton} onClick={() => void startConnect()}>
                <img src="/brand/google-g.png" alt="" width={18} height={18} />
                Connect with Google
              </button>
              <p className={s.cardLede}>Sign in to Google and pick the sheet. LUME can open only the sheets you pick.</p>
            </div>
            {g.email && (
              <details className={s.other}>
                <summary>Other ways</summary>
                {/* the existing share-with-email block */}
              </details>
            )}
```

`startConnect` calls `sheetsClient.connect()` and, on ok, `window.location.assign(r.data.url)`. With no Google key, `g.email` is null and "Other ways" is absent. `.googleButton` follows Google's branding guidelines:
- a white surface with a 1 px `#dadce0` border and `#1f1f1f` text, Roboto or system font, weight 500;
- a 40 px height and a 4 px radius;
- the "G" on the left;
- the same in both themes (on a dark card it stays white);
- a hover shadow and a pressed state.

`AddSheetSheet`:
- takes `connect?`, and passes `connect` to `SheetStep`;
- `choose` receives `{ connectId, sheetId }` or `{ link, sheetId }` and forwards it to `sheetsClient.draft` as is.

`SheetStep`, with `connect`:
- on mount, it calls `sheetsClient.inspect({ connectId })` and shows the file name with the Sheets mark and the tab select;
- it hides the link field and the Check button;
- Continue calls `onChoose({ connectId, sheetId })`.

`SheetStep`'s `onChoose` type widens to `{ link: string; sheetId: number } | { connectId: string; sheetId: number }`.

`Connected.tsx`:

```tsx
"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AddSheetSheet } from "@/components/sheets/AddSheetSheet";
import { Button } from "@/components/ui/Button";
import { sheetsClient } from "@/lib/sheets/client";
import s from "./integrations.module.css";

/** Back from Google (2B §6): finish the hand-back once, then connect the picked file with the usual steps. */
export function Connected() {
  const params = useSearchParams();
  const router = useRouter();
  const [picked, setPicked] = useState<{ connectId: string; file: { id: string; name: string } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const p = params.get("p");
    const sig = params.get("s");
    if (!p || !sig) return setError("This page is for coming back from Google. Start from Settings → Integrations.");
    void sheetsClient.complete({ p, s: sig }).then((r) => (r.ok ? setPicked(r.data) : setError(r.message)));
  }, [params]);
  const again = async () => {
    const r = await sheetsClient.connect();
    if (r.ok) window.location.assign(r.data.url);
  };
  return (
    <div className={s.detail}>
      {error && (
        <div className={s.attention}>
          <p role="alert">{error}</p>
          <Button variant="primary" onClick={() => void again()}>
            Try again
          </Button>
        </div>
      )}
      {!error && !picked && <p className={s.cardLede}>Connecting…</p>}
      <AddSheetSheet
        open={!!picked}
        {...(picked ? { connect: picked } : {})}
        onClose={(savedId) => router.replace(savedId ? `/settings/integrations/${savedId}` : "/settings/integrations")}
      />
    </div>
  );
}
```

`page.tsx` requires `integrations.manage` and renders `<SettingsPage title="Connect with Google" description="Pick up where Google left off."><Suspense><Connected /></Suspense></SettingsPage>`. `useSearchParams` needs a Suspense boundary.

- [ ] **Step 4: Run the tests.** Run `bash scripts/dev.sh run bash -c 'cd apps/web && pnpm exec vitest run src/components/integrations src/components/sheets'`. Expected: PASS.

- [ ] **Step 5: Gate, commit, push**

Message: `feat(web): Connect with Google — the verified path first, Google's own Picker, and back into the usual steps`, with the trailer.

---

### Task 6: Docs, and switching it on

**Files:**
- Create: `docs/runbooks/connect-with-google.md`
- Modify: `docs/runbooks/acceptance.md` (a 2B-2 section), `apps/connect/README.md` (link)

- [ ] **Step 1: Write the runbook.** It is the owner's checklist, in order:
  1. The Google Cloud project and the OAuth consent screen, with the `drive.file` scope, submitted for verification.
  2. The OAuth web client, with the redirect URI `https://connect.lumecrm.in/callback`.
  3. The Picker API enabled, with an API key restricted to the Picker API and to `https://connect.lumecrm.in`.
  4. Deploy `apps/connect` (the Dockerfile) behind TLS at `connect.lumecrm.in`, with its env.
  5. Per client:
     - generate a token (`openssl rand -base64 36`);
     - add `{ url, token }` to `RELAY_INSTANCES`;
     - set `GOOGLE_OAUTH_RELAY_URL` and `GOOGLE_OAUTH_RELAY_TOKEN` in that client's `.env`;
     - restart its API.
  6. Check: Settings → Integrations shows "Connect with Google" first; connect a test sheet end to end.
  7. Rotating a client's token: replace it in both places. Existing sheets keep working, because their grants are refresh tokens held by Google and refreshed through the relay with the new token.
  8. Removing a client: take its entry out of `RELAY_INSTANCES`. Its sheets stop refreshing, and become "needs attention" at their next sync.

- [ ] **Step 2: The acceptance section.**
  - Automated: the protocol tests, the relay tests (consent redirect, Picker page, sealed hand-back, refresh and revocation) and the instance tests (either credential, revocation, relay down, connect and complete single-use).
  - Live: waits for Google's verification and the relay's deployment (the owner's steps above).

- [ ] **Step 3: Gate, commit, push, CI.**

---

## Self-review

- **Spec §6 coverage:**
  - `drive.file` with the Picker: Tasks 2 and 5.
  - The relay with a stateless design and a signed state: Task 2. Code tokens are short-lived in memory, which is recorded as ruling R1 below.
  - The secret only on the relay: Task 2.
  - Tokens handed back one-time and signed: Tasks 1, 2 and 4, sealed rather than POSTed (R2).
  - The refresh token encrypted in `config_enc`: Task 4 (in the grant, then the source config).
  - Refreshes through the relay: Task 3.
  - No lead data through the relay: by construction (Task 2 only sees tokens and a file id).
  - The switch becoming the default: Task 5 ("Other ways").
  - The fake OAuth server in tests: Tasks 2 and 3.
- **Rulings taken in this plan:**
  - **R1.** The relay keeps a tiny in-memory map from `code_token` to tokens, for up to 10 minutes, to bridge the Picker page to `/done` without putting the refresh token in the page. A relay restart mid-connect means pressing Connect again.
  - **R2.** The hand-back is a GET redirect with a sealed payload, not a signed POST. A cross-site POST wouldn't carry LUME's SameSite session cookie, and the sealed payload is unreadable and single-use.
  - **R3.** The instance needs only the relay URL and its token. The spec's `GOOGLE_OAUTH_CLIENT_ID` lives on the relay, where the consent happens.
- **Type consistency:**
  - `Handoff` is the same type in Tasks 1, 2 and 4.
  - `TokenSource` is the same in Task 3 everywhere.
  - `oauthClientFor(oauth, endpoint)(cfg)` is used in the same way in `main.ts`, the harness and `service.ts`.
