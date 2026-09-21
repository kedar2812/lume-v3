# Phase 1A — Identity & Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything that decides *who someone is and what they may do*: first-run setup, sign-in with Argon2id + TOTP, sessions, CSRF, throttling, invites, password reset, the permission engine, roles/teams/users admin, the per-request database scope that row-level security reads, the audit log, and a route × role matrix test that fails CI if any route is unguarded.

**Architecture:** Pure, dependency-free domain logic lives in `packages/core` (crypto, passwords, TOTP, the permission catalog and engine). The schema lives in SQL migrations, with a Drizzle mirror in `packages/db` checked against the live database by a drift test. The API (`apps/api`) is composed from small Fastify plugins:
- `dbContext` gives every request its own transaction, with RLS settings applied via `set_config(..., true)`
- `auth` handles CSRF, the session, the actor, 2FA gating and the permission check
- feature modules each have one `routes.ts` (thin HTTP layer) and one `service.ts` (logic, typed inputs)

Every write that matters calls `audit()` in the same transaction.

**Tech Stack:**
- API and data: Fastify 5, fastify-type-provider-zod 7 + Zod 4, @fastify/cookie, drizzle-orm 0.45 (node-postgres), pg 8
- Crypto and identity: @node-rs/argon2 2, uuid 14 (v7), node:crypto (AES-256-GCM, HMAC-SHA1 TOTP)
- Mail: nodemailer + Mailpit
- Tests: Vitest against real Postgres 17

**Specs:** `docs/superpowers/specs/2026-09-21-phase-1-identity-rbac-leads-design.md` (read first), `docs/LUME_PROJECT_REPORT.md` §5.1, §5.5, §7, §12.1, §12.4–12.5.

## Global Constraints

- `main` only. Every task ends green on `scripts/dev.sh run bash -c 'pnpm lint && pnpm typecheck && pnpm test'` before its commit. Push after each task and watch CI.
- Build host rules from Plan 0A apply (containers only, 127.0.0.1 ports, resource caps, `scripts/dev.sh add` / `fmt` / `run`).
- **Fail closed everywhere.** Missing session → 401. Missing permission → 403. Missing RLS settings → no rows. Unknown config → boot failure.
- Generic auth errors: `INVALID_CREDENTIALS` for any bad email/password combination. Response timing must not depend on whether the email exists.
- Never log or audit secrets: passwords, tokens, TOTP secrets/codes, recovery codes, cookies. Audit diffs hold ids and changed field names/values only.
- Parameterised SQL only (Drizzle or `$n` placeholders). `set_config()` with parameters, never string-built `SET`.
- Out-of-scope records: 404, not 403 (report §4.4).
- A thrown error rolls back the request transaction. A returned (non-thrown) 4xx commits, which is how failed logins record throttle counters.
- Library pins: `zod@^4`, `fastify-type-provider-zod@^7`, `drizzle-orm@^0.45`, `@node-rs/argon2@^2`, `uuid@^14`, `nodemailer@^8 || latest`, `@fastify/cookie@^11`.
- Commits end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Map

| Path | Responsibility |
|---|---|
| `packages/core/src/crypto/tokens.ts` | random tokens, sha256, constant-time compare |
| `packages/core/src/crypto/keyring.ts` | AES-256-GCM envelope encryption, context-bound, key-id versioned |
| `packages/core/src/ids.ts` | UUID v7 |
| `packages/core/src/auth/password.ts` | Argon2id hash/verify/needsRehash, password policy |
| `packages/core/src/auth/breached.ts` | sorted SHA-1 binary search checker |
| `packages/core/src/auth/base32.ts`, `totp.ts`, `recovery.ts` | RFC 4648 base32, RFC 6238 TOTP, recovery codes |
| `packages/core/src/rbac/catalog.ts`, `engine.ts`, `defaults.ts` | permission catalog, effective permissions, seeded roles |
| `packages/core/data/breached-sha1.bin` + `scripts/build-breached-list.mjs` | NCSC top-100k as sorted SHA-1 |
| `packages/db/migrations/0005_identity.sql` … `0007_rls_helpers.sql` | schema, audit log, RLS helper functions |
| `packages/db/src/schema/*.ts` + `schema.drift.test.ts` | Drizzle mirror + drift check |
| `apps/api/src/app.ts` | composition root `buildApp(deps)` |
| `apps/api/src/http/{errors.ts,zod.ts}` | `HttpError`, Zod type-provider wiring |
| `apps/api/src/db/context.ts` | per-request transaction + RLS scope |
| `apps/api/src/crypto/keyring-store.ts` | load/create data keys |
| `apps/api/src/audit/audit.ts` | append-only audit writer |
| `apps/api/src/rbac/{actor.ts,cache.ts,sync.ts,notify.ts}` | actor loading, NOTIFY-busted cache, catalog sync |
| `apps/api/src/auth/{cookies.ts,csrf.ts,sessions.ts,throttle.ts,restrictions.ts,plugin.ts,setup-token.ts}` | auth building blocks |
| `apps/api/src/mail/{mailer.ts,templates.ts}` | SMTP + templates |
| `apps/api/src/modules/{setup,auth,me,invites,users,roles,teams,settings,audit}/{routes.ts,service.ts}` | features |
| `apps/api/test/{harness.ts,matrix.test.ts,probes.ts}` | integration harness + access matrix |
| `infra/compose.dev.yml`, `infra/docker-compose.yml`, `packages/config/src/schema.ts` | Mailpit, env |

---

### Task 1: Zod 4 and core crypto primitives

**Files:**
- Modify: all `package.json`s using zod (via `scripts/dev.sh add`)
- Create: `packages/core/src/crypto/tokens.ts`, `packages/core/src/crypto/keyring.ts`, `packages/core/src/ids.ts`, `packages/core/src/crypto/crypto.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `randomToken(bytes = 32): string` (base64url), `sha256Hex(input: string | Buffer): string`, `safeEqual(a: string, b: string): boolean`
  - `newId(): string` (UUID v7)
  - `class Keyring` with `static create(master: Buffer, keys: StoredKey[])`, `encrypt(plain: string, context: string): Buffer`, `decrypt(blob: Buffer, context: string): string`, `activeKeyId`
  - `newStoredKey(master): StoredKey`, where `StoredKey = { id: string; wrapped: Buffer; active: boolean }`
  - `masterKeyFromBase64(b64): Buffer`

- [ ] **Step 1: Upgrade Zod, add crypto deps**

Run:
```bash
scripts/dev.sh add --filter @lume/config zod@^4
scripts/dev.sh add --filter @lume/core uuid@^14
scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile >/dev/null && pnpm vitest run packages/config'
```
Expected: the 8 config tests still pass under Zod 4. If a message assertion changed wording, keep the test's intent and adjust `schema.ts` (e.g. `z.url()`), not the test's meaning.

- [ ] **Step 2: Write the failing tests**

`packages/core/src/crypto/crypto.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { newId } from "../ids";
import { Keyring, masterKeyFromBase64, newStoredKey } from "./keyring";
import { randomToken, safeEqual, sha256Hex } from "./tokens";

const master = masterKeyFromBase64(Buffer.alloc(32, 9).toString("base64"));

describe("tokens", () => {
  it("random tokens are url-safe and unique", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
  });
  it("sha256Hex matches the known vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("safeEqual compares without early exit and handles length mismatch", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("ids", () => {
  it("are time-ordered UUID v7", () => {
    const a = newId();
    const b = newId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});

describe("Keyring", () => {
  const k1 = newStoredKey(master);
  const ring = Keyring.create(master, [k1]);

  it("round-trips and binds ciphertext to its context", () => {
    const blob = ring.encrypt("JBSWY3DPEHPK3PXP", "totp:user-1");
    expect(ring.decrypt(blob, "totp:user-1")).toBe("JBSWY3DPEHPK3PXP");
    expect(() => ring.decrypt(blob, "totp:user-2")).toThrow();
  });

  it("detects tampering", () => {
    const blob = ring.encrypt("secret", "ctx");
    blob[blob.length - 1] ^= 1;
    expect(() => ring.decrypt(blob, "ctx")).toThrow();
  });

  it("decrypts data written with a retired key after rotation", () => {
    const old = ring.encrypt("before rotation", "ctx");
    const k2 = newStoredKey(master);
    const rotated = Keyring.create(master, [{ ...k1, active: false }, k2]);
    expect(rotated.activeKeyId).toBe(k2.id);
    expect(rotated.decrypt(old, "ctx")).toBe("before rotation");
  });

  it("refuses a wrong master key", () => {
    const other = masterKeyFromBase64(Buffer.alloc(32, 1).toString("base64"));
    expect(() => Keyring.create(other, [k1])).toThrow();
  });

  it("rejects short master keys", () => {
    expect(() => masterKeyFromBase64(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `scripts/dev.sh run pnpm vitest run packages/core/src/crypto`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement**

`packages/core/src/crypto/tokens.ts`:
```ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 256 bits by default, base64url (cookie- and URL-safe, no padding). */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

export const sha256Hex = (input: string | Buffer): string => createHash("sha256").update(input).digest("hex");

/** Constant-time string comparison; unequal lengths still take a comparison's time. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) {
    timingSafeEqual(x, x);
    return false;
  }
  return timingSafeEqual(x, y);
}
```

`packages/core/src/ids.ts`:
```ts
import { v7 } from "uuid";

/** Time-sortable UUID v7 (report §4.3). Postgres 17 has no native v7, so ids are minted in the app. */
export const newId = (): string => v7();
```

`packages/core/src/crypto/keyring.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { newId } from "../ids";

/**
 * Envelope encryption (report §12.5). A random 256-bit data key encrypts values; the data key itself is
 * stored wrapped by LUME_MASTER_KEY. Every ciphertext names the key that made it, so keys can rotate
 * without re-encrypting old data. The caller's `context` (e.g. "totp:<userId>") is authenticated too,
 * so a ciphertext copied onto another row fails to decrypt.
 *
 * Layout: [version 1B][keyId 16B][iv 12B][tag 16B][ciphertext]
 */
const VERSION = 1;
export type StoredKey = { id: string; wrapped: Buffer; active: boolean };

const idToBytes = (id: string) => Buffer.from(id.replace(/-/g, ""), "hex");
const bytesToId = (b: Buffer) => {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

function seal(key: Buffer, plain: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv).setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

function open(key: Buffer, blob: Buffer, aad: Buffer): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12)).setAAD(aad);
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

export function masterKeyFromBase64(b64: string): Buffer {
  const k = Buffer.from(b64, "base64");
  if (k.length < 32) throw new Error("LUME_MASTER_KEY must decode to at least 32 bytes");
  return k.subarray(0, 32);
}

export function newStoredKey(master: Buffer): StoredKey {
  const id = newId();
  const dataKey = randomBytes(32);
  return { id, wrapped: seal(master, dataKey, Buffer.from(`lume-data-key:${id}`)), active: true };
}

export class Keyring {
  private constructor(
    private readonly keys: Map<string, Buffer>,
    readonly activeKeyId: string,
  ) {}

  /** Unwraps every stored key; throws if the master key is wrong or no key is active. */
  static create(master: Buffer, stored: StoredKey[]): Keyring {
    const keys = new Map<string, Buffer>();
    for (const k of stored) keys.set(k.id, open(master, k.wrapped, Buffer.from(`lume-data-key:${k.id}`)));
    const active = stored.filter((k) => k.active);
    if (active.length !== 1) throw new Error(`expected exactly one active data key, found ${active.length}`);
    return new Keyring(keys, active[0]!.id);
  }

  encrypt(plain: string, context: string): Buffer {
    const idBytes = idToBytes(this.activeKeyId);
    const body = seal(this.keys.get(this.activeKeyId)!, Buffer.from(plain, "utf8"), Buffer.concat([idBytes, Buffer.from(context)]));
    return Buffer.concat([Buffer.from([VERSION]), idBytes, body]);
  }

  decrypt(blob: Buffer, context: string): string {
    if (blob[0] !== VERSION) throw new Error("unknown ciphertext version");
    const idBytes = blob.subarray(1, 17);
    const key = this.keys.get(bytesToId(idBytes));
    if (!key) throw new Error("ciphertext was made with an unknown data key");
    return open(key, blob.subarray(17), Buffer.concat([idBytes, Buffer.from(context)])).toString("utf8");
  }
}
```

Append to `packages/core/src/index.ts`:
```ts
export * from "./ids";
export * from "./crypto/tokens";
export * from "./crypto/keyring";
```

- [ ] **Step 5: Run to verify it passes**

Run: `scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile >/dev/null && pnpm vitest run packages/core && pnpm typecheck'`
Expected: all core tests pass (10 new).

- [ ] **Step 6: Commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(core): Zod 4, UUID v7 ids, tokens, context-bound envelope encryption with key rotation

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 2: Passwords — Argon2id, policy, breached list

**Files:**
- Create: `scripts/build-breached-list.mjs`, `packages/core/data/breached-sha1.bin`, `packages/core/src/auth/password.ts`, `packages/core/src/auth/breached.ts`, `packages/core/src/auth/password.test.ts`
- Modify: `packages/core/src/index.ts`, `pnpm-workspace.yaml` (allow `@node-rs/argon2` builds if pnpm asks)

**Interfaces:**
- Produces:
  - `ARGON2_PRODUCTION: Argon2Params` = `{ memoryCost: 65536, timeCost: 3, parallelism: 1 }`
  - `type Argon2Params`
  - `hashPassword(pw, params): Promise<string>`, `verifyPassword(stored, pw): Promise<boolean>`, `needsRehash(stored, params): boolean`
  - `passwordProblems(pw, { email?, isBreached }): PasswordProblem[]`, where `PasswordProblem = "too_short" | "too_long" | "breached" | "contains_email"`
  - `MIN_PASSWORD_LENGTH = 12`, `MAX_PASSWORD_LENGTH = 256`
  - `createBreachedChecker(sortedSha1: Buffer): (pw: string) => boolean`, `loadBreachedChecker(path): Promise<(pw) => boolean>`

- [ ] **Step 1: Build the breached list**

`scripts/build-breached-list.mjs`:
```js
// Builds packages/core/data/breached-sha1.bin: the UK NCSC top-100k passwords as sorted raw SHA-1 digests
// (20 bytes each), so the API can binary-search without ever holding plaintext passwords.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const SRC = "https://raw.githubusercontent.com/danielmiessler/SecLists/master/Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt";
const res = await fetch(SRC);
if (!res.ok) throw new Error(`download failed: ${res.status}`);
const words = [...new Set((await res.text()).split(/\r?\n/).map((w) => w.trim()).filter(Boolean))];
const digests = words.map((w) => createHash("sha1").update(w, "utf8").digest()).sort(Buffer.compare);
await mkdir("packages/core/data", { recursive: true });
await writeFile("packages/core/data/breached-sha1.bin", Buffer.concat(digests));
console.log(`wrote ${digests.length} digests (${digests.length * 20} bytes)`);
```
Run:
```bash
scripts/dev.sh run node scripts/build-breached-list.mjs
scripts/dev.sh fetch packages/core/data/breached-sha1.bin
```
Expected: `wrote ~100000 digests (~2000000 bytes)`. Add `*.bin binary` to `.gitattributes`.

- [ ] **Step 2: Dependencies**

Run: `scripts/dev.sh add --filter @lume/core @node-rs/argon2@^2`
If a later install fails with `ERR_PNPM_IGNORED_BUILDS`, do nothing: `@node-rs/argon2` ships prebuilt binaries and needs no install script. Only add it to `onlyBuiltDependencies` if pnpm explicitly lists it as ignored **and** the import fails.

- [ ] **Step 3: Write the failing tests**

`packages/core/src/auth/password.test.ts`:
```ts
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBreachedChecker, loadBreachedChecker } from "./breached";
import { ARGON2_PRODUCTION, hashPassword, needsRehash, passwordProblems, verifyPassword, type Argon2Params } from "./password";

const FAST: Argon2Params = { memoryCost: 1024, timeCost: 1, parallelism: 1 }; // tests only
const sha1 = (s: string) => createHash("sha1").update(s).digest();

describe("argon2id", () => {
  it("hashes, verifies and rejects the wrong password", async () => {
    const h = await hashPassword("correct horse battery", FAST);
    expect(h.startsWith("$argon2id$v=19$m=1024,t=1,p=1$")).toBe(true);
    expect(await verifyPassword(h, "correct horse battery")).toBe(true);
    expect(await verifyPassword(h, "Correct horse battery")).toBe(false);
  });

  it("treats a malformed stored hash as a failed verify, never a throw", async () => {
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
  });

  it("flags hashes made with other parameters for rehash", async () => {
    const h = await hashPassword("correct horse battery", FAST);
    expect(needsRehash(h, FAST)).toBe(false);
    expect(needsRehash(h, ARGON2_PRODUCTION)).toBe(true);
    expect(needsRehash("$2b$10$legacybcrypt", ARGON2_PRODUCTION)).toBe(true);
  });

  it("uses the report's production cost (≥ 64 MB)", () => {
    expect(ARGON2_PRODUCTION.memoryCost).toBeGreaterThanOrEqual(65536);
  });
});

describe("password policy (report §12.1: length + breach list, no composition rules)", () => {
  const isBreached = createBreachedChecker(Buffer.concat([sha1("passwordpassword"), sha1("qwertyuiop123")].sort(Buffer.compare)));

  it("accepts a long passphrase with no symbols", () => {
    expect(passwordProblems("sunset over the dunes", { isBreached })).toEqual([]);
  });

  it("reports every problem", () => {
    expect(passwordProblems("short", { isBreached })).toEqual(["too_short"]);
    expect(passwordProblems("passwordpassword", { isBreached })).toEqual(["breached"]);
    expect(passwordProblems("x".repeat(257), { isBreached })).toEqual(["too_long"]);
    expect(passwordProblems("tasneem.work!2026", { email: "tasneem@nupuur.com", isBreached })).toEqual(["contains_email"]);
  });
});

describe("breached list", () => {
  it("binary-searches the bundled NCSC list", async () => {
    const check = await loadBreachedChecker(path.resolve(import.meta.dirname, "../../data/breached-sha1.bin"));
    expect(check("password")).toBe(true);
    expect(check("123456")).toBe(true);
    expect(check("a completely unusual lume passphrase 7731")).toBe(false);
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `scripts/dev.sh run pnpm vitest run packages/core/src/auth`
Expected: FAIL, modules not found.

- [ ] **Step 5: Implement**

`packages/core/src/auth/password.ts`:
```ts
import { hash, verify } from "@node-rs/argon2";

export type Argon2Params = { memoryCost: number; timeCost: number; parallelism: number };
/** Report §12.1: Argon2id, memory ≥ 64 MB, parallelism tuned for 2 vCPU. (Argon2id is the library default.) */
export const ARGON2_PRODUCTION: Argon2Params = { memoryCost: 65536, timeCost: 3, parallelism: 1 };

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256; // bounds hashing cost; no composition rules (NIST 800-63B)

export type PasswordProblem = "too_short" | "too_long" | "breached" | "contains_email";

export function passwordProblems(pw: string, ctx: { email?: string; isBreached: (pw: string) => boolean }): PasswordProblem[] {
  if (pw.length > MAX_PASSWORD_LENGTH) return ["too_long"];
  if ([...pw].length < MIN_PASSWORD_LENGTH) return ["too_short"];
  const local = ctx.email?.split("@")[0]?.toLowerCase() ?? "";
  if (local.length >= 4 && pw.toLowerCase().includes(local)) return ["contains_email"];
  if (ctx.isBreached(pw)) return ["breached"];
  return [];
}

export const hashPassword = (pw: string, params: Argon2Params): Promise<string> => hash(pw, params);

export async function verifyPassword(stored: string, pw: string): Promise<boolean> {
  try {
    return await verify(stored, pw);
  } catch {
    return false;
  }
}

const PARAMS_RE = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/;
/** True if the stored hash isn't Argon2id with exactly these parameters; upgrade it on the next successful login. */
export function needsRehash(stored: string, params: Argon2Params): boolean {
  const m = PARAMS_RE.exec(stored);
  return !m || Number(m[1]) !== params.memoryCost || Number(m[2]) !== params.timeCost || Number(m[3]) !== params.parallelism;
}
```

`packages/core/src/auth/breached.ts`:
```ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const DIGEST = 20;

/** `sorted` holds raw SHA-1 digests in ascending order (see scripts/build-breached-list.mjs). */
export function createBreachedChecker(sorted: Buffer): (pw: string) => boolean {
  if (sorted.length % DIGEST !== 0) throw new Error("breached list is not a whole number of SHA-1 digests");
  const n = sorted.length / DIGEST;
  return (pw) => {
    const d = createHash("sha1").update(pw, "utf8").digest();
    let lo = 0;
    let hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const c = Buffer.compare(sorted.subarray(mid * DIGEST, mid * DIGEST + DIGEST), d);
      if (c === 0) return true;
      if (c < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  };
}

export async function loadBreachedChecker(file: string): Promise<(pw: string) => boolean> {
  return createBreachedChecker(await readFile(file));
}
```

Append to `packages/core/src/index.ts`:
```ts
export * from "./auth/password";
export * from "./auth/breached";
```

- [ ] **Step 6: Run to verify it passes**

Run: `scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile >/dev/null && pnpm vitest run packages/core && pnpm typecheck'`
Expected: all pass.

- [ ] **Step 7: Commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(core): Argon2id passwords with rehash, NIST-style policy, NCSC breached-password list

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 3: TOTP and recovery codes

**Files:**
- Create: `packages/core/src/auth/base32.ts`, `packages/core/src/auth/totp.ts`, `packages/core/src/auth/recovery.ts`, `packages/core/src/auth/totp.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `base32Encode(buf): string`, `base32Decode(s): Buffer`
  - `newTotpSecret(): string` (base32, 20 bytes)
  - `totpCode(secretB32, atMs, digits = 6): string`
  - `verifyTotp(secretB32, code, { nowMs, window = 1, lastUsedStep?: number | null }): number | null` (the matched time step, or null)
  - `otpauthUri({ secret, account, issuer }): string`
  - `generateRecoveryCodes(n = 10): string[]` (format `XXXXX-XXXXX`), `normalizeRecoveryCode(input): string`, `hashRecoveryCode(code): string`

- [ ] **Step 1: Write the failing tests**

`packages/core/src/auth/totp.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode } from "./base32";
import { generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode } from "./recovery";
import { newTotpSecret, otpauthUri, totpCode, verifyTotp } from "./totp";

// RFC 6238 Appendix B uses the ASCII secret "12345678901234567890" (SHA-1).
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("base32 (RFC 4648)", () => {
  it("matches the RFC test vectors and round-trips", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI").toString()).toBe("foobar");
    expect(base32Decode("mzxw 6ytb oi").toString()).toBe("foobar");
  });
});

describe("TOTP (RFC 6238)", () => {
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("t=%is → %s", (t, code) => {
    expect(totpCode(RFC_SECRET, t * 1000)).toBe(code);
  });

  it("accepts ±1 step of clock drift and nothing beyond", () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now - 30_000), { nowMs: now })).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now + 30_000), { nowMs: now })).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now - 90_000), { nowMs: now })).toBeNull();
  });

  it("refuses a code at or before the last used step (no replay)", () => {
    const now = 1_700_000_000_000;
    const code = totpCode(RFC_SECRET, now);
    const step = verifyTotp(RFC_SECRET, code, { nowMs: now })!;
    expect(verifyTotp(RFC_SECRET, code, { nowMs: now, lastUsedStep: step })).toBeNull();
  });

  it("rejects malformed codes", () => {
    expect(verifyTotp(RFC_SECRET, "12345", { nowMs: 0 })).toBeNull();
    expect(verifyTotp(RFC_SECRET, "abcdef", { nowMs: 0 })).toBeNull();
  });

  it("makes 160-bit secrets and a standard otpauth URI", () => {
    const s = newTotpSecret();
    expect(base32Decode(s)).toHaveLength(20);
    const uri = otpauthUri({ secret: s, account: "tasneem@nupuur.com", issuer: "LUME · Nupuur Coaching" });
    expect(uri).toMatch(/^otpauth:\/\/totp\/LUME%20%C2%B7%20Nupuur%20Coaching:tasneem%40nupuur\.com\?/);
    expect(uri).toContain(`secret=${s}`);
    expect(uri).toContain("algorithm=SHA1&digits=6&period=30");
  });
});

describe("recovery codes", () => {
  it("makes 10 distinct, unambiguous codes", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
  });

  it("normalises user input before hashing", () => {
    const [c] = generateRecoveryCodes(1);
    expect(hashRecoveryCode(normalizeRecoveryCode(` ${c!.toLowerCase().replace("-", " ")} `))).toBe(hashRecoveryCode(c!));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/dev.sh run pnpm vitest run packages/core/src/auth/totp.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`packages/core/src/auth/base32.ts`:
```ts
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const s = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
```

`packages/core/src/auth/totp.ts`:
```ts
import { createHmac, randomBytes } from "node:crypto";
import { base32Decode, base32Encode } from "./base32";

const PERIOD_S = 30;

export const newTotpSecret = (): string => base32Encode(randomBytes(20));

function hotp(key: Buffer, counter: number, digits: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const totpCode = (secretB32: string, atMs: number, digits = 6): string =>
  hotp(base32Decode(secretB32), Math.floor(atMs / 1000 / PERIOD_S), digits);

/**
 * Returns the time step the code matched (store it as `totp_last_step`), or null. Steps at or before
 * `lastUsedStep` are refused, so a captured code can never be replayed.
 */
export function verifyTotp(secretB32: string, code: string, opts: { nowMs: number; window?: number; lastUsedStep?: number | null }): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretB32);
  const now = Math.floor(opts.nowMs / 1000 / PERIOD_S);
  const window = opts.window ?? 1;
  let matched: number | null = null;
  for (let step = now - window; step <= now + window; step++) {
    // compare every candidate (no early return) so timing doesn't reveal which step matched
    if (hotp(key, step, 6) === code && (opts.lastUsedStep == null || step > opts.lastUsedStep)) matched ??= step;
  }
  return matched;
}

export function otpauthUri({ secret, account, issuer }: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${PERIOD_S}`;
}
```

`packages/core/src/auth/recovery.ts`:
```ts
import { randomInt } from "node:crypto";
import { sha256Hex } from "../crypto/tokens";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const group = () => Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

/** ~50 bits each: random enough that SHA-256 (not a slow hash) is the right storage. */
export function generateRecoveryCodes(n = 10): string[] {
  const codes = new Set<string>();
  while (codes.size < n) codes.add(`${group()}-${group()}`);
  return [...codes];
}

export function normalizeRecoveryCode(input: string): string {
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 10 ? `${s.slice(0, 5)}-${s.slice(5)}` : s;
}

export const hashRecoveryCode = (code: string): string => sha256Hex(`lume-recovery:${code}`);
```

Append to `packages/core/src/index.ts`:
```ts
export * from "./auth/base32";
export * from "./auth/totp";
export * from "./auth/recovery";
```

- [ ] **Step 4: Run to verify it passes**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run packages/core && pnpm typecheck'`
Expected: all pass, including the five RFC 6238 vectors.

- [ ] **Step 5: Commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(core): RFC 6238 TOTP (vector-tested, replay-safe) and recovery codes

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 4: Permission catalog and engine

**Files:**
- Create: `packages/core/src/rbac/catalog.ts`, `packages/core/src/rbac/engine.ts`, `packages/core/src/rbac/defaults.ts`, `packages/core/src/rbac/rbac.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `PERMISSIONS: readonly PermissionDef[]`, where `PermissionDef = { key, group, label, description, scoped: boolean }`
  - `type PermissionKey`, `type Scope = "own" | "team" | "all"`, `SCOPE_RANK`
  - `type Grant = { key: PermissionKey; scope: Scope | null }`
  - `effectivePermissions(grants: Grant[]): Map<PermissionKey, Scope | true>` (union, widest scope)
  - `type Actor = { userId: string; isOwner: boolean; perms: ReadonlyMap<PermissionKey, Scope | true>; teamMemberIds: readonly string[]; twoFactorEnabled: boolean; roleIds: readonly string[] }`
  - `can(actor, key, atLeast?: Scope): boolean`, `scopeOf(actor, key): Scope | null`
  - `requiresTwoFactor(actor): boolean`, `leadScope(actor): Scope | null`
  - `DEFAULT_ROLES: { name, description, color, grants: Grant[] }[]` (Admin, Sales)
  - `isPermissionKey(s): s is PermissionKey`

- [ ] **Step 1: Write the failing tests**

`packages/core/src/rbac/rbac.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { PERMISSIONS, isPermissionKey } from "./catalog";
import { DEFAULT_ROLES } from "./defaults";
import { can, effectivePermissions, leadScope, requiresTwoFactor, scopeOf, type Actor } from "./engine";

const actor = (grants: Parameters<typeof effectivePermissions>[0], extra: Partial<Actor> = {}): Actor => ({
  userId: "u1",
  isOwner: false,
  perms: effectivePermissions(grants),
  teamMemberIds: [],
  twoFactorEnabled: false,
  roleIds: [],
  ...extra,
});

describe("catalog (report §7.2)", () => {
  it("has unique, well-formed keys and the report's scoped set", () => {
    const keys = PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
    const scoped = PERMISSIONS.filter((p) => p.scoped).map((p) => p.key).sort();
    expect(scoped).toEqual([
      "analytics.view", "calendar.view", "leads.assign", "leads.bulk_edit", "leads.change_stage", "leads.contact.full",
      "leads.contact.reveal", "leads.delete", "leads.edit", "leads.export", "leads.view", "messages.send",
      "messages.send_queue", "tasks.manage_others",
    ]);
    expect(isPermissionKey("leads.view")).toBe(true);
    expect(isPermissionKey("leads.steal")).toBe(false);
  });
});

describe("effective permissions", () => {
  it("unions roles and keeps the widest scope", () => {
    const a = actor([
      { key: "leads.view", scope: "own" },
      { key: "leads.view", scope: "team" },
      { key: "leads.view", scope: "own" },
      { key: "templates.use", scope: null },
    ]);
    expect(scopeOf(a, "leads.view")).toBe("team");
    expect(can(a, "leads.view", "own")).toBe(true);
    expect(can(a, "leads.view", "all")).toBe(false);
    expect(can(a, "templates.use")).toBe(true);
    expect(can(a, "leads.export")).toBe(false);
    expect(leadScope(a)).toBe("team");
  });

  it("gives the owner everything, with all scope", () => {
    const o = actor([], { isOwner: true });
    expect(can(o, "security.manage")).toBe(true);
    expect(scopeOf(o, "leads.view")).toBe("all");
    expect(leadScope(o)).toBe("all");
  });

  it("has no lead scope without leads.view", () => {
    expect(leadScope(actor([{ key: "templates.use", scope: null }]))).toBeNull();
  });
});

describe("mandatory two-factor (report §12.1)", () => {
  it.each([
    [[{ key: "users.manage", scope: null }], true],
    [[{ key: "roles.manage", scope: null }], true],
    [[{ key: "leads.export", scope: "own" }], true],
    [[{ key: "security.manage", scope: null }], true],
    [[{ key: "leads.contact.full", scope: "all" }], true],
    [[{ key: "leads.contact.full", scope: "own" }], false],
    [[{ key: "leads.view", scope: "all" }], false],
  ] as const)("%j → %s", (grants, expected) => {
    expect(requiresTwoFactor(actor([...grants]))).toBe(expected);
  });
  it("always applies to the owner", () => expect(requiresTwoFactor(actor([], { isOwner: true }))).toBe(true));
});

describe("seeded roles", () => {
  it("Admin has every permission at all scope", () => {
    const admin = DEFAULT_ROLES.find((r) => r.name === "Admin")!;
    expect(admin.grants).toHaveLength(PERMISSIONS.length);
    for (const g of admin.grants) expect(g.scope).toBe(PERMISSIONS.find((p) => p.key === g.key)!.scoped ? "all" : null);
  });

  it("Sales matches report §7.3 exactly: reveal, never full contact, no export/assign/delete", () => {
    const sales = DEFAULT_ROLES.find((r) => r.name === "Sales")!;
    expect(Object.fromEntries(sales.grants.map((g) => [g.key, g.scope]))).toEqual({
      "leads.view": "own",
      "leads.edit": "own",
      "leads.change_stage": "own",
      "leads.contact.reveal": "own",
      "messages.send": "own",
      "templates.use": null,
      "calendar.view": "own",
      "calendar.connect": null,
      "analytics.view": "own",
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/dev.sh run pnpm vitest run packages/core/src/rbac`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`packages/core/src/rbac/catalog.ts`:
```ts
export type Scope = "own" | "team" | "all";
export const SCOPE_RANK: Record<Scope, number> = { own: 1, team: 2, all: 3 };

/**
 * Report §7.2. Permissions live in code because each one corresponds to code that checks it; roles are data.
 * Adding a key here makes it appear in the roles screen on the next boot (synced to the permissions table).
 */
export const PERMISSIONS = [
  { key: "leads.view", group: "Leads", scoped: true, label: "See leads", description: "Open the leads list and lead pages" },
  { key: "leads.create", group: "Leads", scoped: false, label: "Create leads", description: "Add leads by hand" },
  { key: "leads.edit", group: "Leads", scoped: true, label: "Edit leads", description: "Change fields and add notes" },
  { key: "leads.delete", group: "Leads", scoped: true, label: "Delete leads", description: "Move leads to the bin" },
  { key: "leads.assign", group: "Leads", scoped: true, label: "Assign leads to people", description: "Hand leads to a teammate" },
  { key: "leads.change_stage", group: "Leads", scoped: true, label: "Move leads between stages", description: "Drag on the board or change stage" },
  { key: "leads.contact.full", group: "Contact details", scoped: true, label: "See full contact details", description: "Phone, email and Instagram unmasked" },
  { key: "leads.contact.reveal", group: "Contact details", scoped: true, label: "Reveal one lead's contact", description: "Each reveal is logged and counted" },
  { key: "leads.bulk_edit", group: "Leads", scoped: true, label: "Bulk edit", description: "Change stage, tags or fields for many leads" },
  { key: "leads.export", group: "Leads", scoped: true, label: "Export to spreadsheet", description: "Download leads as a CSV file" },
  { key: "leads.import", group: "Leads", scoped: false, label: "Import leads", description: "CSV import and lead sources" },
  { key: "messages.send", group: "Messaging", scoped: true, label: "Send WhatsApp messages", description: "One click, from approved templates" },
  { key: "messages.send_queue", group: "Messaging", scoped: true, label: "Use the send queue", description: "Message many leads one after another" },
  { key: "templates.use", group: "Messaging", scoped: false, label: "Use templates", description: "Pick templates when messaging" },
  { key: "templates.manage", group: "Messaging", scoped: false, label: "Manage templates", description: "Create and edit templates" },
  { key: "tasks.manage_others", group: "Tasks", scoped: true, label: "Manage others' follow-ups", description: "Create and edit tasks for other people" },
  { key: "calendar.view", group: "Insight", scoped: true, label: "See lead meetings", description: "Calendar with lead calls only" },
  { key: "calendar.connect", group: "Insight", scoped: false, label: "Connect a calendar", description: "Connect their own Google Calendar" },
  { key: "analytics.view", group: "Insight", scoped: true, label: "See analytics", description: "Charts and numbers" },
  { key: "analytics.revenue", group: "Insight", scoped: false, label: "See revenue", description: "Money figures in analytics" },
  { key: "pipelines.manage", group: "Admin", scoped: false, label: "Manage pipelines", description: "Pipelines and stages" },
  { key: "fields.manage", group: "Admin", scoped: false, label: "Manage fields", description: "Custom fields" },
  { key: "settings.manage", group: "Admin", scoped: false, label: "Change settings", description: "Business settings" },
  { key: "users.manage", group: "Admin", scoped: false, label: "Manage people", description: "Invite, disable, change access" },
  { key: "roles.manage", group: "Admin", scoped: false, label: "Manage roles", description: "Create roles and set permissions" },
  { key: "teams.manage", group: "Admin", scoped: false, label: "Manage teams", description: "Teams and team leads" },
  { key: "integrations.manage", group: "Admin", scoped: false, label: "Manage integrations", description: "Sheets, Calendly, webhooks" },
  { key: "audit.view", group: "Security", scoped: false, label: "See the audit log", description: "Who did what, when" },
  { key: "security.manage", group: "Security", scoped: false, label: "Manage security", description: "Sessions, 2FA policy, alerts" },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];
export type PermissionDef = (typeof PERMISSIONS)[number];
const KEYS = new Set<string>(PERMISSIONS.map((p) => p.key));
export const isPermissionKey = (s: string): s is PermissionKey => KEYS.has(s);
export const permissionDef = (k: PermissionKey): PermissionDef => PERMISSIONS.find((p) => p.key === k)!;
```

`packages/core/src/rbac/engine.ts`:
```ts
import { PERMISSIONS, SCOPE_RANK, permissionDef, type PermissionKey, type Scope } from "./catalog";

export type Grant = { key: PermissionKey; scope: Scope | null };

export type Actor = {
  userId: string;
  isOwner: boolean;
  perms: ReadonlyMap<PermissionKey, Scope | true>;
  /** Members of every team this user leads (drives `team` scope). */
  teamMemberIds: readonly string[];
  twoFactorEnabled: boolean;
  roleIds: readonly string[];
};

/** Union of all the user's roles; a scoped permission keeps its widest scope (report §5.1). */
export function effectivePermissions(grants: Grant[]): Map<PermissionKey, Scope | true> {
  const out = new Map<PermissionKey, Scope | true>();
  for (const g of grants) {
    if (!permissionDef(g.key).scoped) {
      out.set(g.key, true);
      continue;
    }
    const scope = g.scope ?? "own";
    const prev = out.get(g.key);
    if (prev === undefined || prev === true || SCOPE_RANK[scope] > SCOPE_RANK[prev]) out.set(g.key, scope);
  }
  return out;
}

export function scopeOf(actor: Actor, key: PermissionKey): Scope | null {
  if (actor.isOwner) return "all";
  const v = actor.perms.get(key);
  return v === undefined ? null : v === true ? "all" : v;
}

export function can(actor: Actor, key: PermissionKey, atLeast?: Scope): boolean {
  if (actor.isOwner) return true;
  const v = actor.perms.get(key);
  if (v === undefined) return false;
  if (!atLeast || v === true) return true;
  return SCOPE_RANK[v] >= SCOPE_RANK[atLeast];
}

/** The scope row-level security enforces for lead tables (report §7.4). */
export const leadScope = (actor: Actor): Scope | null => scopeOf(actor, "leads.view");

const TWO_FACTOR_KEYS: PermissionKey[] = ["users.manage", "roles.manage", "leads.export", "security.manage"];
/** Report §12.1: owner, people/role/security managers, anyone who can export, full contacts at `all`. */
export function requiresTwoFactor(actor: Actor): boolean {
  if (actor.isOwner) return true;
  if (TWO_FACTOR_KEYS.some((k) => actor.perms.has(k))) return true;
  return actor.perms.get("leads.contact.full") === "all";
}

export const ALL_GRANTS: Grant[] = PERMISSIONS.map((p) => ({ key: p.key, scope: p.scoped ? "all" : null }));
```

`packages/core/src/rbac/defaults.ts`:
```ts
import { ALL_GRANTS, type Grant } from "./engine";

export type RoleSeed = { name: string; description: string; color: string; grants: Grant[] };

/** Seeded at first-run setup; ordinary, editable, deletable roles afterwards (report §7.1). */
export const DEFAULT_ROLES: RoleSeed[] = [
  { name: "Admin", description: "Sees and controls everything", color: "accent", grants: ALL_GRANTS },
  {
    name: "Sales",
    description: "Works their own leads; contact details masked with Reveal",
    color: "ok",
    grants: [
      { key: "leads.view", scope: "own" },
      { key: "leads.edit", scope: "own" },
      { key: "leads.change_stage", scope: "own" },
      { key: "leads.contact.reveal", scope: "own" },
      { key: "messages.send", scope: "own" },
      { key: "templates.use", scope: null },
      { key: "calendar.view", scope: "own" },
      { key: "calendar.connect", scope: null },
      { key: "analytics.view", scope: "own" },
    ],
  },
];
```

Append to `packages/core/src/index.ts`:
```ts
export * from "./rbac/catalog";
export * from "./rbac/engine";
export * from "./rbac/defaults";
```

- [ ] **Step 4: Run to verify it passes**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run packages/core && pnpm typecheck'`
Expected: all pass.

- [ ] **Step 5: Commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(core): permission catalog, widest-scope union engine, mandatory-2FA rule, seeded roles

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 5: Identity schema, audit log, RLS helpers (+ Drizzle mirror)

**Files:**
- Create: `packages/db/migrations/0005_identity.sql`, `0006_audit_log.sql`, `0007_rls_helpers.sql`
- Create: `packages/db/src/schema/identity.ts`, `packages/db/src/schema/index.ts`, `packages/db/src/schema.drift.test.ts`, `packages/db/src/identity.test.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Produces:
  - tables `settings, users, roles, permissions, role_permissions, user_roles, teams, team_members, sessions, recovery_codes, user_invites, password_resets, auth_throttle, crypto_keys, audit_log`
  - SQL functions `lume_user() uuid`, `lume_scope() text`, `lume_team_members() uuid[]`, `set_updated_at()` trigger
  - Drizzle tables exported from `@lume/db` as `schema.<table>` (camelCase names, e.g. `schema.userRoles`)

- [ ] **Step 1: Write the failing tests**

`packages/db/src/identity.test.ts`:
```ts
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import { MIGRATIONS_DIR_DEFAULT, migrate } from "./migrate";
import { installQueueSchema } from "./queue-install";
import { createTestDatabase, type DbRole, type TestDatabase } from "./testing";

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
  await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
  await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
});
afterAll(async () => db.drop());

async function as<T = Record<string, unknown>>(role: DbRole, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: db.url(role) });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}

describe("audit_log is append-only (report §12.4)", () => {
  it("the app can insert and read but never change or remove entries", async () => {
    await as("lume_app", "INSERT INTO audit_log (action, entity_type) VALUES ('test.event', 'test')");
    expect((await as("lume_app", "SELECT action FROM audit_log")).length).toBe(1);
    await expect(as("lume_app", "UPDATE audit_log SET action = 'x'")).rejects.toThrow(/permission denied|append-only/);
    await expect(as("lume_app", "DELETE FROM audit_log")).rejects.toThrow(/permission denied|append-only/);
    await expect(as("lume_app", "TRUNCATE audit_log")).rejects.toThrow(/permission denied/);
  });

  it("even the schema owner cannot rewrite history", async () => {
    await expect(as("lume_owner", "UPDATE audit_log SET action = 'x'")).rejects.toThrow(/append-only/);
    await expect(as("lume_owner", "DELETE FROM audit_log")).rejects.toThrow(/append-only/);
  });
});

describe("identity constraints", () => {
  it("allows exactly one owner and one settings row", async () => {
    await as("lume_app", "INSERT INTO users (id, email, name, status, is_owner) VALUES (gen_random_uuid(), 'a@x.com', 'A', 'active', true)");
    await expect(as("lume_app", "INSERT INTO users (id, email, name, status, is_owner) VALUES (gen_random_uuid(), 'b@x.com', 'B', 'active', true)")).rejects.toThrow(/users_one_owner/);
    await expect(as("lume_app", "INSERT INTO settings (id, business_name, timezone, currency, default_country_iso, industry_preset) VALUES (2, 'x', 'UTC', 'AED', 'AE', 'general')")).rejects.toThrow(/check/i);
  });

  it("emails are case-insensitive and unique", async () => {
    await expect(as("lume_app", "INSERT INTO users (id, email, name, status) VALUES (gen_random_uuid(), 'A@X.COM', 'A2', 'active')")).rejects.toThrow(/duplicate key/);
  });

  it("stamps updated_at on change", async () => {
    const [before] = await as<{ updated_at: Date }>("lume_app", "SELECT updated_at FROM users WHERE email = 'a@x.com'");
    await new Promise((r) => setTimeout(r, 20));
    await as("lume_app", "UPDATE users SET name = 'A!' WHERE email = 'a@x.com'");
    const [after] = await as<{ updated_at: Date }>("lume_app", "SELECT updated_at FROM users WHERE email = 'a@x.com'");
    expect(after!.updated_at.getTime()).toBeGreaterThan(before!.updated_at.getTime());
  });
});

describe("RLS helper functions fail closed", () => {
  it("return null/empty without settings and the values inside a scoped transaction", async () => {
    const [none] = await as<{ u: string | null; s: string | null; t: string[] }>("lume_app", "SELECT lume_user() AS u, lume_scope() AS s, lume_team_members() AS t");
    expect(none).toEqual({ u: null, s: null, t: [] });
    const c = new pg.Client({ connectionString: db.url("lume_app") });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'team', true), set_config('lume.team_member_ids', $2, true)", [
        "0190e0c0-0000-7000-8000-000000000001",
        "{0190e0c0-0000-7000-8000-000000000002}",
      ]);
      const { rows } = await c.query("SELECT lume_user()::text AS u, lume_scope() AS s, lume_team_members()::text[] AS t");
      expect(rows[0]).toEqual({ u: "0190e0c0-0000-7000-8000-000000000001", s: "team", t: ["0190e0c0-0000-7000-8000-000000000002"] });
      await c.query("COMMIT");
      const after = await c.query("SELECT lume_user() AS u");
      expect(after.rows[0].u).toBeNull(); // SET LOCAL ended with the transaction
    } finally {
      await c.end();
    }
  });
});
```

`packages/db/src/schema.drift.test.ts`:
```ts
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import { MIGRATIONS_DIR_DEFAULT, migrate } from "./migrate";
import { installQueueSchema } from "./queue-install";
import * as schema from "./schema";
import { createTestDatabase, type TestDatabase } from "./testing";

let db: TestDatabase;
let columns: Map<string, Map<string, { nullable: boolean }>>;
beforeAll(async () => {
  db = await createTestDatabase();
  await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
  await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
  const c = new pg.Client({ connectionString: db.url("lume_owner") });
  await c.connect();
  const { rows } = await c.query<{ t: string; c: string; n: string }>(
    "SELECT table_name AS t, column_name AS c, is_nullable AS n FROM information_schema.columns WHERE table_schema = 'public'",
  );
  await c.end();
  columns = new Map();
  for (const r of rows) {
    if (!columns.has(r.t)) columns.set(r.t, new Map());
    columns.get(r.t)!.set(r.c, { nullable: r.n === "YES" });
  }
});
afterAll(async () => db.drop());

const tables = Object.values(schema).filter((v): v is PgTable => typeof v === "object" && v !== null && Symbol.for("drizzle:IsDrizzleTable") in v);

describe("Drizzle mirror matches the migrations", () => {
  it.each(tables.map((t) => [getTableConfig(t).name, t] as const))("%s", (name, table) => {
    const live = columns.get(name);
    expect(live, `table ${name} missing in the database`).toBeDefined();
    const cfg = getTableConfig(table);
    expect(cfg.columns.map((c) => c.name).sort()).toEqual([...live!.keys()].sort());
    for (const col of cfg.columns) expect(`${name}.${col.name} nullable=${!col.notNull}`).toBe(`${name}.${col.name} nullable=${live!.get(col.name)!.nullable}`);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `scripts/dev.sh add --filter @lume/db drizzle-orm@^0.45 && scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile >/dev/null && pnpm vitest run packages/db'`
Expected: FAIL (`./schema` missing; `audit_log` does not exist).

- [ ] **Step 3: Write the migrations**

`packages/db/migrations/0005_identity.sql`:
```sql
-- Identity, access and settings (report §5.1, §5.2 settings). Lead tables arrive in Phase 1B.
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TABLE settings (
  id                  smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  business_name       text        NOT NULL,
  logo_asset_id       uuid,
  timezone            text        NOT NULL,
  currency            char(3)     NOT NULL,
  default_country_iso char(2)     NOT NULL,
  week_start          smallint    NOT NULL DEFAULT 1 CHECK (week_start BETWEEN 0 AND 6),
  working_hours       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  digest_default_time time        NOT NULL DEFAULT '08:00',
  industry_preset     text        NOT NULL,
  security            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  retention           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  field_defs_version  integer     NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                   uuid        PRIMARY KEY,
  email                citext      NOT NULL UNIQUE,
  name                 text        NOT NULL,
  password_hash        text,
  status               text        NOT NULL CHECK (status IN ('invited', 'active', 'disabled')),
  is_owner             boolean     NOT NULL DEFAULT false,
  timezone             text,
  theme                text        NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'porcelain', 'obsidian')),
  totp_secret_enc      bytea,
  totp_pending_enc     bytea,
  totp_enabled         boolean     NOT NULL DEFAULT false,
  totp_last_step       bigint,
  must_change_password boolean     NOT NULL DEFAULT false,
  last_login_at        timestamptz,
  disabled_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_one_owner ON users ((true)) WHERE is_owner;

CREATE TABLE roles (
  id           uuid        PRIMARY KEY,
  name         citext      NOT NULL,
  description  text        NOT NULL DEFAULT '',
  color        text        NOT NULL DEFAULT 'accent',
  login_hours  jsonb,
  ip_allowlist cidr[],
  created_by   uuid        REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE UNIQUE INDEX roles_live_name ON roles (name) WHERE deleted_at IS NULL;

CREATE TABLE permissions (
  key            text    PRIMARY KEY,
  "group"        text    NOT NULL,
  label          text    NOT NULL,
  description    text    NOT NULL,
  supports_scope boolean NOT NULL,
  retired        boolean NOT NULL DEFAULT false
);

CREATE TABLE role_permissions (
  role_id        uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions (key),
  scope          text CHECK (scope IN ('own', 'team', 'all')),
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles (id),
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX user_roles_role ON user_roles (role_id);

CREATE TABLE teams (
  id         uuid        PRIMARY KEY,
  name       citext      NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX teams_live_name ON teams (name) WHERE deleted_at IS NULL;

CREATE TABLE team_members (
  team_id uuid    NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  user_id uuid    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  is_lead boolean NOT NULL DEFAULT false,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user ON team_members (user_id);

CREATE TABLE sessions (
  id             text        PRIMARY KEY, -- sha256(token); the token itself is never stored
  user_id        uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  stage          text        NOT NULL CHECK (stage IN ('mfa', 'full')),
  ip             inet,
  user_agent     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text
);
CREATE INDEX sessions_live_user ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE recovery_codes (
  id        uuid        PRIMARY KEY,
  user_id   uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash text        NOT NULL,
  used_at   timestamptz,
  UNIQUE (user_id, code_hash)
);

CREATE TABLE user_invites (
  id          uuid        PRIMARY KEY,
  email       citext      NOT NULL,
  name        text        NOT NULL,
  role_ids    uuid[]      NOT NULL,
  token_hash  text        NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  invited_by  uuid        REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE password_resets (
  id         uuid        PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text        NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_throttle (
  key               text        PRIMARY KEY, -- 'ip:<addr>' or 'acct:<sha256(email)>'
  failures          integer     NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  next_allowed_at   timestamptz,
  locked_until      timestamptz,
  lockouts          integer     NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crypto_keys (
  id         uuid        PRIMARY KEY,
  wrapped    bytea       NOT NULL,
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX crypto_keys_one_active ON crypto_keys ((true)) WHERE active;

CREATE TRIGGER settings_updated_at BEFORE UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER roles_updated_at BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER teams_updated_at BEFORE UPDATE ON teams FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER auth_throttle_updated_at BEFORE UPDATE ON auth_throttle FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The worker never touches identity secrets.
REVOKE ALL ON sessions, recovery_codes, password_resets, user_invites, auth_throttle, crypto_keys FROM lume_worker;
```

`packages/db/migrations/0006_audit_log.sql`:
```sql
-- Report §5.5 / §12.4. Every sensitive read or write leaves a trace that no one can edit.
CREATE TABLE audit_log (
  id            bigserial   PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  actor_ip      inet,
  action        text        NOT NULL,
  entity_type   text        NOT NULL,
  entity_id     text,
  diff          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  request_id    text
);
CREATE INDEX audit_log_at ON audit_log (at DESC);
CREATE INDEX audit_log_actor ON audit_log (actor_user_id, at DESC);
CREATE INDEX audit_log_entity ON audit_log (entity_type, entity_id, at DESC);

CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();

REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM lume_app, lume_worker;
GRANT INSERT, SELECT ON audit_log TO lume_app, lume_worker;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO lume_app, lume_worker;
```

`packages/db/migrations/0007_rls_helpers.sql`:
```sql
-- Request-scoped settings the API sets with set_config(..., is_local => true) at the start of every
-- request transaction (report §7.4). Without them every helper returns NULL/empty: policies fail closed.
CREATE FUNCTION lume_user() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('lume.user_id', true), '')::uuid
$$;

CREATE FUNCTION lume_scope() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('lume.lead_scope', true), '')
$$;

CREATE FUNCTION lume_team_members() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('lume.team_member_ids', true), '')::uuid[], '{}'::uuid[])
$$;
```

- [ ] **Step 4: Drizzle mirror**

`packages/db/src/schema/identity.ts`:
```ts
import { sql } from "drizzle-orm";
import { bigint, bigserial, boolean, char, customType, integer, jsonb, pgTable, primaryKey, smallint, text, time, timestamp, uuid } from "drizzle-orm/pg-core";

const citext = customType<{ data: string }>({ dataType: () => "citext" });
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const inet = customType<{ data: string }>({ dataType: () => "inet" });
const cidrArray = customType<{ data: string[] }>({ dataType: () => "cidr[]" });
const tz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const settings = pgTable("settings", {
  id: smallint("id").primaryKey().default(1),
  businessName: text("business_name").notNull(),
  logoAssetId: uuid("logo_asset_id"),
  timezone: text("timezone").notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  defaultCountryIso: char("default_country_iso", { length: 2 }).notNull(),
  weekStart: smallint("week_start").notNull().default(1),
  workingHours: jsonb("working_hours").notNull().default(sql`'{}'::jsonb`),
  digestDefaultTime: time("digest_default_time").notNull().default("08:00"),
  industryPreset: text("industry_preset").notNull(),
  security: jsonb("security").$type<SecuritySettings>().notNull().default(sql`'{}'::jsonb`),
  retention: jsonb("retention").notNull().default(sql`'{}'::jsonb`),
  fieldDefsVersion: integer("field_defs_version").notNull().default(0),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

export type SecuritySettings = {
  sessionIdleHours?: number;
  sessionAbsoluteDays?: number;
  requireTwoFactorForAll?: boolean;
};

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: citext("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"),
  status: text("status").$type<"invited" | "active" | "disabled">().notNull(),
  isOwner: boolean("is_owner").notNull().default(false),
  timezone: text("timezone"),
  theme: text("theme").$type<"system" | "porcelain" | "obsidian">().notNull().default("system"),
  totpSecretEnc: bytea("totp_secret_enc"),
  totpPendingEnc: bytea("totp_pending_enc"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  totpLastStep: bigint("totp_last_step", { mode: "number" }),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  lastLoginAt: tz("last_login_at"),
  disabledAt: tz("disabled_at"),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

export type LoginHours = { days: number[]; from: string; to: string }; // business timezone, "HH:MM"

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey(),
  name: citext("name").notNull(),
  description: text("description").notNull().default(""),
  color: text("color").notNull().default("accent"),
  loginHours: jsonb("login_hours").$type<LoginHours | null>(),
  ipAllowlist: cidrArray("ip_allowlist"),
  createdBy: uuid("created_by"),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  deletedAt: tz("deleted_at"),
});

export const permissions = pgTable("permissions", {
  key: text("key").primaryKey(),
  group: text("group").notNull(),
  label: text("label").notNull(),
  description: text("description").notNull(),
  supportsScope: boolean("supports_scope").notNull(),
  retired: boolean("retired").notNull().default(false),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id").notNull(),
    permissionKey: text("permission_key").notNull(),
    scope: text("scope").$type<"own" | "team" | "all" | null>(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })],
);

export const userRoles = pgTable("user_roles", { userId: uuid("user_id").notNull(), roleId: uuid("role_id").notNull() }, (t) => [
  primaryKey({ columns: [t.userId, t.roleId] }),
]);

export const teams = pgTable("teams", {
  id: uuid("id").primaryKey(),
  name: citext("name").notNull(),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  deletedAt: tz("deleted_at"),
});

export const teamMembers = pgTable(
  "team_members",
  { teamId: uuid("team_id").notNull(), userId: uuid("user_id").notNull(), isLead: boolean("is_lead").notNull().default(false) },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  stage: text("stage").$type<"mfa" | "full">().notNull(),
  ip: inet("ip"),
  userAgent: text("user_agent"),
  createdAt: tz("created_at").notNull().defaultNow(),
  lastSeenAt: tz("last_seen_at").notNull().defaultNow(),
  expiresAt: tz("expires_at").notNull(),
  revokedAt: tz("revoked_at"),
  revokedReason: text("revoked_reason"),
});

export const recoveryCodes = pgTable("recovery_codes", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  codeHash: text("code_hash").notNull(),
  usedAt: tz("used_at"),
});

export const userInvites = pgTable("user_invites", {
  id: uuid("id").primaryKey(),
  email: citext("email").notNull(),
  name: text("name").notNull(),
  roleIds: uuid("role_ids").array().notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: tz("expires_at").notNull(),
  acceptedAt: tz("accepted_at"),
  revokedAt: tz("revoked_at"),
  invitedBy: uuid("invited_by"),
  createdAt: tz("created_at").notNull().defaultNow(),
});

export const passwordResets = pgTable("password_resets", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: tz("expires_at").notNull(),
  usedAt: tz("used_at"),
  createdAt: tz("created_at").notNull().defaultNow(),
});

export const authThrottle = pgTable("auth_throttle", {
  key: text("key").primaryKey(),
  failures: integer("failures").notNull().default(0),
  windowStartedAt: tz("window_started_at").notNull().defaultNow(),
  nextAllowedAt: tz("next_allowed_at"),
  lockedUntil: tz("locked_until"),
  lockouts: integer("lockouts").notNull().default(0),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

export const cryptoKeys = pgTable("crypto_keys", {
  id: uuid("id").primaryKey(),
  wrapped: bytea("wrapped").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: tz("created_at").notNull().defaultNow(),
});

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: tz("at").notNull().defaultNow(),
  actorUserId: uuid("actor_user_id"),
  actorIp: inet("actor_ip"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  diff: jsonb("diff").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  requestId: text("request_id"),
});
```
Note: `bytea` via `customType` returns a `Buffer` with node-postgres, as intended.

`packages/db/src/schema/index.ts`:
```ts
export * from "./identity";
```
Append to `packages/db/src/index.ts`:
```ts
export * as schema from "./schema";
export type { LoginHours, SecuritySettings } from "./schema";
```

- [ ] **Step 5: Run to verify they pass**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run packages/db && pnpm typecheck'`
Expected: identity (6), drift (one per table: 15) and the existing DB tests pass. `schema.test.ts`'s `schema_migrations` count assertion becomes 7. Update that expectation (`toBe(4)` → `toBe(7)`) and the restore-test sanity threshold stays `>= 1`.

- [ ] **Step 6: Commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(db): identity schema, append-only audit log, fail-closed RLS helpers, Drizzle mirror with drift test

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 6: API foundations — composition root, Zod provider, errors, request transaction

**Files:**
- Create: `apps/api/src/http/errors.ts`, `apps/api/src/db/context.ts`, `apps/api/src/app.ts`, `apps/api/test/harness.ts`, `apps/api/src/db/context.test.ts`
- Modify: `apps/api/src/server.ts` (accept a `configure` hook for type provider), `apps/api/src/errors.ts` (use `HttpError`), `packages/config/src/schema.ts` (new API vars), `apps/api/src/main.ts`

**Interfaces:**
- Produces:
  - `class HttpError(status: number, code: string, message: string, details?)` and helpers `badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`, `tooMany`
  - `type Db = NodePgDatabase<typeof schema>`
  - `FastifyRequest.db: Db`, `FastifyRequest.actor: Actor | null`, `FastifyRequest.session`
  - `dbContext` plugin (`{ pool }`); route config `{ db?: false }` opts out
  - `applyRequestScope(client, actor)`
  - `buildApp(deps: AppDeps): Promise<FastifyInstance>`, where `AppDeps = { pool; keyring; mailer; config: AppConfig; clock; setupTokens; isBreached; argon2; logger? }`
  - `AppConfig = { publicUrl: string; cookieSecure: boolean }`
  - Test harness: `createHarness(): Promise<Harness>`, where `Harness = { app, pool, db (Drizzle as owner for fixtures), mail: SentMail[], clock: { now: Date; advance(ms) }, url(role), close() }`

- [ ] **Step 1: Dependencies and config**

Run:
```bash
scripts/dev.sh add --filter @lume/api fastify-type-provider-zod@^7 zod@^4 @fastify/cookie@^11 drizzle-orm@^0.45 "@lume/db@workspace:*" "@lume/core@workspace:*"
```
Extend `apiSchema` in `packages/config/src/schema.ts`:
```ts
  LUME_PUBLIC_URL: z.url(),
  SMTP_URL: z.url().optional(),
  MAIL_FROM: z.string().min(3).optional(),
  BREACHED_LIST_FILE: z.string().min(1).default("/app/data/breached-sha1.bin"),
```
Add `LUME_PUBLIC_URL: "https://lume.localhost:8443"` to the valid api env in `config.test.ts`.

- [ ] **Step 2: Write the failing tests**

`apps/api/src/db/context.test.ts`:
```ts
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../test/harness";
import { HttpError } from "../http/errors";

let h: Harness;
beforeAll(async () => {
  h = await createHarness({
    extraRoutes: (app) => {
      app.post("/t/write-then-throw", { config: { public: true } }, async (req) => {
        await req.db.execute(sql`INSERT INTO audit_log (action, entity_type) VALUES ('t.thrown', 't')`);
        throw new HttpError(409, "CONFLICT", "boom");
      });
      app.post("/t/write-then-401", { config: { public: true } }, async (req, reply) => {
        await req.db.execute(sql`INSERT INTO audit_log (action, entity_type) VALUES ('t.returned', 't')`);
        return reply.code(401).send({ error: { code: "INVALID_CREDENTIALS", message: "no" } });
      });
      app.get("/t/scope", { config: { public: true } }, async (req) => {
        const r = await req.db.execute(sql`SELECT lume_user()::text AS u, lume_scope() AS s`);
        return r.rows[0];
      });
      app.get("/t/nodb", { config: { public: true, db: false } }, async (req) => ({ hasDb: Boolean(req.db) }));
    },
  });
});
afterAll(async () => h.close());

const count = async (action: string) => (await h.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = $1", [action])).rows[0].n;

describe("per-request transaction", () => {
  it("rolls back when the handler throws", async () => {
    const res = await h.app.inject({ method: "POST", url: "/t/write-then-throw", ...(await h.csrf()) });
    expect(res.statusCode).toBe(409);
    expect(await count("t.thrown")).toBe(0);
  });

  it("commits when the handler returns a 4xx (so failed logins still record throttling)", async () => {
    const res = await h.app.inject({ method: "POST", url: "/t/write-then-401", ...(await h.csrf()) });
    expect(res.statusCode).toBe(401);
    expect(await count("t.returned")).toBe(1);
  });

  it("has no RLS scope for anonymous requests and never leaks one between requests", async () => {
    const res = await h.app.inject({ method: "GET", url: "/t/scope" });
    expect(res.json()).toEqual({ u: null, s: null });
  });

  it("returns every connection to the pool", async () => {
    await Promise.all(Array.from({ length: 12 }, () => h.app.inject({ method: "GET", url: "/t/scope" })));
    expect(h.pool.totalCount - h.pool.idleCount).toBe(0);
  });

  it("routes can opt out of a transaction", async () => {
    expect((await h.app.inject({ method: "GET", url: "/t/nodb" })).json()).toEqual({ hasDb: false });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile >/dev/null && pnpm vitest run apps/api/src/db'`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement**

`apps/api/src/http/errors.ts`:
```ts
/** Thrown by services; the error handler turns it into { error: { code, message, details? } } (report §4.4). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
export const badRequest = (code: string, message: string, details?: unknown) => new HttpError(400, code, message, details);
export const unauthorized = (code = "UNAUTHENTICATED", message = "Sign in to continue") => new HttpError(401, code, message);
export const forbidden = (code = "FORBIDDEN", message = "You don't have access to this") => new HttpError(403, code, message);
export const notFound = (code = "NOT_FOUND", message = "Not found") => new HttpError(404, code, message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
export const tooMany = (retryAfterSec: number) => new HttpError(429, "TOO_MANY_ATTEMPTS", "Too many attempts. Try again shortly.", { retryAfterSec });
```

Replace `apps/api/src/errors.ts`:
```ts
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { HttpError } from "./http/errors";

export type ErrorBody = { error: { code: string; message: string; details?: unknown } };

export function errorHandler(err: FastifyError | HttpError, req: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof HttpError) {
    if (err.status === 429 && typeof (err.details as { retryAfterSec?: number })?.retryAfterSec === "number") {
      void reply.header("Retry-After", String((err.details as { retryAfterSec: number }).retryAfterSec));
    }
    void reply.code(err.status).send({ error: { code: err.code, message: err.message, ...(err.details !== undefined && err.status !== 429 ? { details: err.details } : {}) } } satisfies ErrorBody);
    return;
  }
  if (hasZodFastifySchemaValidationErrors(err) || (err as FastifyError).validation) {
    void reply.code(400).send({ error: { code: "VALIDATION_FAILED", message: "Request is invalid", details: (err as FastifyError).validation } } satisfies ErrorBody);
    return;
  }
  const status = (err as FastifyError).statusCode ?? 500;
  if (status < 500) {
    void reply.code(status).send({ error: { code: (err as FastifyError).code ?? "BAD_REQUEST", message: err.message } } satisfies ErrorBody);
    return;
  }
  req.log.error({ err }, "unhandled error");
  void reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" } } satisfies ErrorBody);
}

export function notFoundHandler(_req: FastifyRequest, reply: FastifyReply): void {
  void reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found" } } satisfies ErrorBody);
}
```

`apps/api/src/db/context.ts`:
```ts
import type { FastifyInstance, FastifyRequest } from "fastify";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { leadScope, type Actor } from "@lume/core";
import { schema } from "@lume/db";

export type Db = NodePgDatabase<typeof schema>;

declare module "fastify" {
  interface FastifyContextConfig {
    /** false: this route gets no transaction (health checks, streaming). */
    db?: boolean;
  }
  interface FastifyRequest {
    db: Db;
    actor: Actor | null;
  }
}

const held = new WeakMap<FastifyRequest, { client: pg.PoolClient; failed: boolean }>();

/** Row-level security reads these three settings (0007_rls_helpers.sql); SET LOCAL semantics via is_local=true. */
export async function applyRequestScope(client: pg.PoolClient, actor: Actor): Promise<void> {
  await client.query("SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', $2, true), set_config('lume.team_member_ids', $3, true)", [
    actor.userId,
    leadScope(actor) ?? "",
    `{${actor.teamMemberIds.join(",")}}`,
  ]);
}

async function finish(req: FastifyRequest): Promise<void> {
  const h = held.get(req);
  if (!h) return;
  held.delete(req);
  try {
    await h.client.query(h.failed ? "ROLLBACK" : "COMMIT");
  } finally {
    h.client.release();
  }
}

/**
 * Every request runs in exactly one transaction (report §7.4). Throwing rolls back; returning (even a 4xx)
 * commits. The transaction opens in preHandler, after the auth hook has resolved the actor.
 */
export async function dbContext(app: FastifyInstance, opts: { pool: pg.Pool }): Promise<void> {
  app.decorateRequest("db", null as unknown as Db);
  app.decorateRequest("actor", null);

  app.addHook("preHandler", async (req) => {
    if (req.routeOptions.config?.db === false) return;
    const client = await opts.pool.connect();
    held.set(req, { client, failed: false });
    await client.query("BEGIN");
    if (req.actor) await applyRequestScope(client, req.actor);
    req.db = drizzle(client, { schema });
  });
  app.addHook("onError", async (req) => {
    const h = held.get(req);
    if (h) h.failed = true;
  });
  app.addHook("onSend", async (req, _reply, payload) => {
    await finish(req);
    return payload;
  });
  // Safety nets: the client is always returned, even if the socket dies mid-request.
  app.addHook("onResponse", finish);
  app.addHook("onRequestAbort", async (req) => {
    const h = held.get(req);
    if (h) h.failed = true;
    await finish(req);
  });
}
```

`apps/api/src/app.ts`:
```ts
import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type pg from "pg";
import type { Argon2Params, Keyring } from "@lume/core";
import { dbContext } from "./db/context";
import { dbChecks } from "./health";
import { buildServer } from "./server";

export type Clock = () => Date;
export type AppConfig = { publicUrl: string; cookieSecure: boolean };
export type AppDeps = {
  pool: pg.Pool;
  keyring: Keyring;
  mailer: import("./mail/mailer").Mailer;
  config: AppConfig;
  clock: Clock;
  setupTokens: import("./auth/setup-token").SetupTokens;
  isBreached: (pw: string) => boolean;
  argon2: Argon2Params;
  logger?: FastifyServerOptions["logger"];
  /** Tests only: extra routes registered inside the authenticated scope. */
  extraRoutes?: (app: FastifyInstance) => void;
};

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  return buildServer({
    checks: dbChecks(deps.pool),
    logger: deps.logger,
    configure: (app) => {
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
    },
    register: async (app) => {
      await app.register(cookie);
      await app.register(dbContext, { pool: deps.pool });
      // Tasks 7+ register the auth plugin and feature modules here.
      deps.extraRoutes?.(app);
    },
  });
}
```

Modify `apps/api/src/server.ts`: add `configure?: (app: FastifyInstance) => void` to `ServerDeps` and call `deps.configure?.(app)` right after creating the instance (before `setErrorHandler`).

`apps/api/test/harness.ts`:
```ts
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { Keyring, QUEUE_NAMES, createBreachedChecker, masterKeyFromBase64, newStoredKey } from "@lume/core";
import { MIGRATIONS_DIR_DEFAULT, createTestDatabase, installQueueSchema, migrate, schema, type DbRole } from "@lume/db";
import { buildApp, type AppDeps } from "../src/app";
import type { SetupTokens } from "../src/auth/setup-token";
import type { Mailer, OutgoingMail } from "../src/mail/mailer";

export type Harness = {
  app: FastifyInstance;
  pool: pg.Pool;
  /** Owner-level Drizzle handle for arranging fixtures (bypasses nothing: identity tables have no RLS). */
  db: ReturnType<typeof drizzle<typeof schema>>;
  mail: OutgoingMail[];
  clock: { now: Date; advance(ms: number): void };
  setupToken: string;
  url(role: DbRole): string;
  /** Fresh CSRF cookie + header pair for a mutating inject(). */
  csrf(): Promise<{ headers: Record<string, string>; cookies: Record<string, string> }>;
  close(): Promise<void>;
};

export async function createHarness(opts: { extraRoutes?: AppDeps["extraRoutes"] } = {}): Promise<Harness> {
  const tdb = await createTestDatabase();
  await installQueueSchema(tdb.url("lume_owner"), QUEUE_NAMES);
  await migrate(tdb.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
  const pool = new pg.Pool({ connectionString: tdb.url("lume_app"), max: 8 });
  const ownerPool = new pg.Pool({ connectionString: tdb.url("lume_owner"), max: 2 });
  const master = masterKeyFromBase64(Buffer.alloc(32, 7).toString("base64"));
  const key = newStoredKey(master);
  await pool.query("INSERT INTO crypto_keys (id, wrapped, active) VALUES ($1, $2, true)", [key.id, key.wrapped]);
  const mail: OutgoingMail[] = [];
  const mailer: Mailer = { send: async (m) => void mail.push(m) };
  const clock = { now: new Date("2026-09-21T09:00:00Z"), advance(ms: number) { this.now = new Date(this.now.getTime() + ms); } };
  let token: string | null = "test-setup-token-0000000000000000";
  const setupTokens: SetupTokens = { current: () => token, burn: () => void (token = null) };
  const app = await buildApp({
    pool,
    keyring: Keyring.create(master, [key]),
    mailer,
    config: { publicUrl: "https://lume.test", cookieSecure: true },
    clock: () => clock.now,
    setupTokens,
    isBreached: createBreachedChecker(Buffer.alloc(0)),
    argon2: { memoryCost: 1024, timeCost: 1, parallelism: 1 },
    extraRoutes: opts.extraRoutes,
  });
  return {
    app,
    pool,
    db: drizzle(ownerPool, { schema }),
    mail,
    clock,
    setupToken: "test-setup-token-0000000000000000",
    url: (role) => tdb.url(role),
    async csrf() {
      const res = await app.inject({ method: "GET", url: "/api/v1/auth/csrf" });
      const c = res.cookies.find((x) => x.name === "__Host-lume_csrf")!;
      return { headers: { "x-csrf-token": c.value, origin: "https://lume.test" }, cookies: { "__Host-lume_csrf": c.value } };
    },
    async close() {
      await app.close();
      await pool.end();
      await ownerPool.end();
      await tdb.drop();
    },
  };
}
```
Note: `csrf()` needs `GET /api/v1/auth/csrf` (Task 7). For this task, add a temporary route in `app.ts` behind `deps.extraRoutes` … No: implement Task 7's `csrf.ts` route **first** as part of this step. Create `apps/api/src/auth/csrf.ts` exactly as in Task 7, Step 3, and register `csrfRoutes` + `csrfGuard` in `buildApp` now. Task 7 then only adds tests for it.

Also create stub modules so imports resolve: `apps/api/src/mail/mailer.ts` (as in Task 11, Step 3) and `apps/api/src/auth/setup-token.ts`:
```ts
import { randomToken } from "@lume/core";

/** The one-time first-run token, printed in the API logs while zero users exist (report §15.3). */
export type SetupTokens = { current(): string | null; burn(): void };

export function processSetupTokens(needsSetup: boolean, log: (msg: string) => void): SetupTokens {
  let token = needsSetup ? randomToken(24) : null;
  if (token) log(`LUME first-run setup token: ${token} (open /setup and paste it; valid until the owner account exists)`);
  return { current: () => token, burn: () => void (token = null) };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile >/dev/null && pnpm vitest run apps/api && pnpm typecheck'`
Expected: context (5) pass, and existing API tests stay green.

- [ ] **Step 6: Commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(api): composition root, Zod provider, HttpError, one transaction per request (throw = rollback)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 7: CSRF, sessions, actor cache and the auth plugin

**Files:**
- Create: `apps/api/src/auth/cookies.ts`, `apps/api/src/auth/csrf.ts`, `apps/api/src/auth/sessions.ts`, `apps/api/src/auth/restrictions.ts`, `apps/api/src/rbac/actor.ts`, `apps/api/src/rbac/cache.ts`, `apps/api/src/rbac/notify.ts`, `apps/api/src/rbac/sync.ts`, `apps/api/src/auth/plugin.ts`, `apps/api/src/audit/audit.ts`
- Test: `apps/api/src/auth/auth.test.ts`, `apps/api/src/auth/restrictions.test.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/route-guard.ts` (accept `auth.self`), `apps/api/test/harness.ts` (add `seedUser`, `signIn` helpers)

**Interfaces:**
- Consumes: `Actor`, `effectivePermissions`, `can`, `requiresTwoFactor`, `sha256Hex`, `randomToken`, `safeEqual`, `newId` (core); `schema` (db).
- Produces:
  - Cookies `SESSION_COOKIE = "__Host-lume_session"`, `CSRF_COOKIE = "__Host-lume_csrf"`
  - `csrfGuard(publicUrl)` hook; `GET /api/v1/auth/csrf` → `{ token }`
  - `SessionPolicy = { idleMs; absoluteMs; mfaPendingMs }` and `sessionPolicy(settingsSecurity)`
  - `createSession(db, { userId, stage, ip, userAgent, now, policy }): Promise<{ token: string; id: string; expiresAt: Date }>`
  - `readSession(pool, token, now, policy): Promise<SessionRow & { user: UserRow } | null>`
  - `revokeSession(db, id, reason)`, `revokeUserSessions(db, userId, reason, exceptId?)`
  - `loadActor(pool, userId): Promise<Actor | null>`
  - `ActorCache` (`get(userId)`, `invalidate(userId?)`) with `startRbacListener(pool, cache)`
  - `notifyRbac(db, userId?)`, run in the same transaction as the change
  - `syncPermissionCatalog(pool)`
  - `checkLoginRestrictions({ roles, ip, now, timezone }): "ok" | "ip" | "hours"`
  - `audit(req, { action, entityType, entityId?, diff? })`
  - Route config `permission: PermissionKey | "auth.self"`, `allowDuringEnrolment?: boolean`, `allowMfaPending?: boolean`
  - `FastifyRequest.session: { id; stage; userId } | null`
  - Harness adds:
    - `seedUser({ email?, name?, grants?, owner?, totp?, status? }): Promise<{ id; email; password; totpSecret? }>`
    - `signIn(user): Promise<AuthedClient>`, where `AuthedClient = { cookies; headers; inject(opts) }` with session + CSRF prefilled
    - `seedTeam(leadId, memberIds)`

- [ ] **Step 1: Write the failing tests**

`apps/api/src/auth/restrictions.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { checkLoginRestrictions } from "./restrictions";

const at = (iso: string) => new Date(iso);

describe("per-role login restrictions (report §12.1)", () => {
  it("passes when no role restricts anything", () => {
    expect(checkLoginRestrictions({ roles: [{ loginHours: null, ipAllowlist: null }], ip: "1.2.3.4", now: at("2026-09-21T03:00:00Z"), timezone: "Asia/Dubai" })).toBe("ok");
  });

  it("uses the business timezone for allowed hours", () => {
    const roles = [{ loginHours: { days: [1, 2, 3, 4, 5], from: "09:00", to: "21:00" }, ipAllowlist: null }];
    // Monday 21 Sep 2026, 08:30 in Dubai = 04:30Z → blocked; 09:30 Dubai = 05:30Z → allowed
    expect(checkLoginRestrictions({ roles, ip: "1.1.1.1", now: at("2026-09-21T04:30:00Z"), timezone: "Asia/Dubai" })).toBe("hours");
    expect(checkLoginRestrictions({ roles, ip: "1.1.1.1", now: at("2026-09-21T05:30:00Z"), timezone: "Asia/Dubai" })).toBe("ok");
    // Sunday is not an allowed day
    expect(checkLoginRestrictions({ roles, ip: "1.1.1.1", now: at("2026-09-20T08:00:00Z"), timezone: "Asia/Dubai" })).toBe("hours");
  });

  it("checks IPv4 and IPv6 allowlists", () => {
    const roles = [{ loginHours: null, ipAllowlist: ["203.0.113.0/24", "2001:db8::/32"] }];
    expect(checkLoginRestrictions({ roles, ip: "203.0.113.9", now: at("2026-09-21T09:00:00Z"), timezone: "UTC" })).toBe("ok");
    expect(checkLoginRestrictions({ roles, ip: "2001:db8::1", now: at("2026-09-21T09:00:00Z"), timezone: "UTC" })).toBe("ok");
    expect(checkLoginRestrictions({ roles, ip: "198.51.100.1", now: at("2026-09-21T09:00:00Z"), timezone: "UTC" })).toBe("ip");
  });

  it("follows the union rule: if any of the user's roles is unrestricted, they may sign in", () => {
    const roles = [
      { loginHours: { days: [1], from: "09:00", to: "10:00" }, ipAllowlist: null },
      { loginHours: null, ipAllowlist: null },
    ];
    expect(checkLoginRestrictions({ roles, ip: "1.1.1.1", now: at("2026-09-22T23:00:00Z"), timezone: "UTC" })).toBe("ok");
  });
});
```

`apps/api/src/auth/auth.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../test/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness({
    extraRoutes: (app) => {
      app.get("/api/v1/t/leads", { config: { permission: "leads.view" } }, async (req) => ({ user: req.actor!.userId }));
      app.get("/api/v1/t/self", { config: { permission: "auth.self" } }, async () => ({ ok: true }));
      app.post("/api/v1/t/change", { config: { permission: "auth.self" } }, async () => ({ ok: true }));
    },
  });
});
afterAll(async () => h.close());

describe("authentication plugin", () => {
  it("401 without a session, 403 without the permission, 200 with it", async () => {
    expect((await h.app.inject({ method: "GET", url: "/api/v1/t/leads" })).statusCode).toBe(401);
    const noPerms = await h.signIn(await h.seedUser({ grants: [] }));
    expect((await noPerms.inject({ method: "GET", url: "/api/v1/t/leads" })).statusCode).toBe(403);
    expect((await noPerms.inject({ method: "GET", url: "/api/v1/t/self" })).statusCode).toBe(200);
    const rep = await h.signIn(await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] }));
    expect((await rep.inject({ method: "GET", url: "/api/v1/t/leads" })).statusCode).toBe(200);
  });

  it("rejects state changes without a matching CSRF token or from another origin", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [] }));
    expect((await c.inject({ method: "POST", url: "/api/v1/t/change" })).statusCode).toBe(200);
    expect((await c.inject({ method: "POST", url: "/api/v1/t/change", headers: { "x-csrf-token": "forged" } })).statusCode).toBe(403);
    expect((await c.inject({ method: "POST", url: "/api/v1/t/change", headers: { origin: "https://evil.example" } })).statusCode).toBe(403);
    expect((await c.inject({ method: "POST", url: "/api/v1/t/change", headers: { "sec-fetch-site": "cross-site" } })).statusCode).toBe(403);
  });

  it("disabling a user ends their session on the very next request (report §17 Phase 1)", async () => {
    const u = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] });
    const c = await h.signIn(u);
    expect((await c.inject({ method: "GET", url: "/api/v1/t/leads" })).statusCode).toBe(200);
    await h.pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [u.id]);
    expect((await c.inject({ method: "GET", url: "/api/v1/t/leads" })).statusCode).toBe(401);
    const { rows } = await h.pool.query("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL", [u.id]);
    expect(rows[0].n).toBe(0);
  });

  it("expires idle sessions (12 h) and absolute ones (7 d)", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [] }));
    h.clock.advance(11 * 3600_000);
    expect((await c.inject({ method: "GET", url: "/api/v1/t/self" })).statusCode).toBe(200);
    h.clock.advance(12 * 3600_000 + 1);
    expect((await c.inject({ method: "GET", url: "/api/v1/t/self" })).statusCode).toBe(401);
  });

  it("forces two-factor enrolment on roles that require it", async () => {
    const admin = await h.signIn(await h.seedUser({ grants: [{ key: "users.manage", scope: null }] }));
    const r = await admin.inject({ method: "GET", url: "/api/v1/t/self" });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("TWO_FACTOR_REQUIRED");
  });

  it("permission changes apply on the next request (NOTIFY busts the cache)", async () => {
    const u = await h.seedUser({ grants: [] });
    const c = await h.signIn(u);
    expect((await c.inject({ method: "GET", url: "/api/v1/t/leads" })).statusCode).toBe(403);
    await h.grant(u.id, [{ key: "leads.view", scope: "own" }]); // inserts + pg_notify('lume_rbac', userId)
    await h.waitForRbacNotify();
    expect((await c.inject({ method: "GET", url: "/api/v1/t/leads" })).statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `scripts/dev.sh run pnpm vitest run apps/api/src/auth`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`apps/api/src/auth/cookies.ts`:
```ts
import type { FastifyReply } from "fastify";

/** __Host- prefix: Secure, Path=/, no Domain; the browser refuses to let a subdomain overwrite it. */
export const SESSION_COOKIE = "__Host-lume_session";
export const CSRF_COOKIE = "__Host-lume_csrf";

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date, secure: boolean): void {
  void reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, secure, sameSite: "lax", path: "/", expires: expiresAt });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  void reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure, sameSite: "lax", path: "/" });
}
```

`apps/api/src/auth/csrf.ts`:
```ts
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomToken, safeEqual } from "@lume/core";
import { forbidden } from "../http/errors";
import { CSRF_COOKIE } from "./cookies";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

declare module "fastify" {
  interface FastifyContextConfig {
    /** false: exempt from CSRF (signed webhooks only). */
    csrf?: boolean;
  }
}

/**
 * Report §12.1 CSRF: SameSite cookies + Origin/Sec-Fetch-Site + double-submit token, on every
 * state-changing request, including public ones (login CSRF is real).
 */
export function assertCsrf(req: FastifyRequest, publicOrigin: string): void {
  if (SAFE.has(req.method) || req.routeOptions.config?.csrf === false) return;
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") throw forbidden("CSRF", "Cross-site request refused");
  const origin = req.headers.origin;
  if (origin && origin !== publicOrigin) throw forbidden("CSRF", "Cross-origin request refused");
  const cookie = req.cookies[CSRF_COOKIE];
  const header = req.headers["x-csrf-token"];
  if (!cookie || typeof header !== "string" || !safeEqual(cookie, header)) throw forbidden("CSRF", "Missing or invalid CSRF token");
}

export async function csrfRoutes(app: FastifyInstance, opts: { secure: boolean }): Promise<void> {
  app.get("/api/v1/auth/csrf", { config: { public: true } }, async (req, reply) => {
    const existing = req.cookies[CSRF_COOKIE];
    const token = existing && /^[A-Za-z0-9_-]{43}$/.test(existing) ? existing : randomToken();
    // Readable by JS on purpose: the page echoes it in X-CSRF-Token (double-submit).
    void reply.setCookie(CSRF_COOKIE, token, { httpOnly: false, secure: opts.secure, sameSite: "lax", path: "/" });
    return { token };
  });
}
```

`apps/api/src/auth/sessions.ts`:
```ts
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type pg from "pg";
import { randomToken, sha256Hex } from "@lume/core";
import type { SecuritySettings } from "@lume/db";
import type { Db } from "../db/context";
import { schema } from "@lume/db";

export type SessionPolicy = { idleMs: number; absoluteMs: number; mfaPendingMs: number };
const H = 3_600_000;

export function sessionPolicy(s: SecuritySettings | undefined): SessionPolicy {
  return { idleMs: (s?.sessionIdleHours ?? 12) * H, absoluteMs: (s?.sessionAbsoluteDays ?? 7) * 24 * H, mfaPendingMs: 5 * 60_000 };
}

export type LiveSession = {
  id: string;
  userId: string;
  stage: "mfa" | "full";
  lastSeenAt: Date;
  user: { status: "invited" | "active" | "disabled"; isOwner: boolean; totpEnabled: boolean };
};

export async function createSession(
  db: Db,
  a: { userId: string; stage: "mfa" | "full"; ip: string | null; userAgent: string | null; now: Date; policy: SessionPolicy },
): Promise<{ token: string; id: string; expiresAt: Date }> {
  const token = randomToken();
  const id = sha256Hex(token);
  const expiresAt = new Date(a.now.getTime() + (a.stage === "mfa" ? a.policy.mfaPendingMs : a.policy.absoluteMs));
  await db.insert(schema.sessions).values({ id, userId: a.userId, stage: a.stage, ip: a.ip, userAgent: a.userAgent?.slice(0, 400) ?? null, createdAt: a.now, lastSeenAt: a.now, expiresAt });
  return { token, id, expiresAt };
}

/**
 * Resolves a cookie token to a live session. Enforces revoked, absolute and idle expiry and the user's status;
 * a disabled user's sessions are revoked on sight. Runs outside the request transaction (auth happens first).
 */
export async function readSession(pool: pg.Pool, token: string, now: Date, policy: SessionPolicy): Promise<LiveSession | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const id = sha256Hex(token);
  const { rows } = await pool.query(
    `SELECT s.id, s.user_id, s.stage, s.last_seen_at, s.expires_at, s.revoked_at, u.status, u.is_owner, u.totp_enabled
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r || r.revoked_at) return null;
  if (r.expires_at <= now) return null;
  if (r.stage === "full" && now.getTime() - r.last_seen_at.getTime() > policy.idleMs) {
    await pool.query("UPDATE sessions SET revoked_at = $2, revoked_reason = 'idle' WHERE id = $1 AND revoked_at IS NULL", [id, now]);
    return null;
  }
  if (r.status !== "active") {
    await pool.query("UPDATE sessions SET revoked_at = $2, revoked_reason = 'user_disabled' WHERE user_id = $1 AND revoked_at IS NULL", [r.user_id, now]);
    return null;
  }
  // Writing last_seen_at on every request would churn the table; once a minute is plenty for idle expiry.
  if (now.getTime() - r.last_seen_at.getTime() > 60_000) await pool.query("UPDATE sessions SET last_seen_at = $2 WHERE id = $1", [id, now]);
  return { id, userId: r.user_id, stage: r.stage, lastSeenAt: r.last_seen_at, user: { status: r.status, isOwner: r.is_owner, totpEnabled: r.totp_enabled } };
}

export async function revokeSession(db: Db, id: string, reason: string, now: Date): Promise<void> {
  await db.update(schema.sessions).set({ revokedAt: now, revokedReason: reason }).where(and(eq(schema.sessions.id, id), isNull(schema.sessions.revokedAt)));
}

export async function revokeUserSessions(db: Db, userId: string, reason: string, now: Date, exceptId?: string): Promise<number> {
  const where = [eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)];
  if (exceptId) where.push(ne(schema.sessions.id, exceptId));
  const res = await db.update(schema.sessions).set({ revokedAt: now, revokedReason: reason }).where(and(...where)).returning({ id: schema.sessions.id });
  return res.length;
}

export const sessionIdFromToken = (token: string) => sha256Hex(token);
export const _sqlNow = sql`now()`; // exported for tests that need DB time
```

`apps/api/src/auth/restrictions.ts`:
```ts
import { BlockList, isIPv6 } from "node:net";
import type { LoginHours } from "@lume/db";

type RoleRestriction = { loginHours: LoginHours | null; ipAllowlist: string[] | null };

function localParts(now: Date, timezone: string): { day: number; hm: string } {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const parts = Object.fromEntries(f.formatToParts(now).map((p) => [p.type, p.value]));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!);
  return { day, hm: `${parts.hour}:${parts.minute}` };
}

function ipAllowed(ip: string, cidrs: string[]): boolean {
  const list = new BlockList();
  for (const c of cidrs) {
    const [net, bits] = c.split("/");
    list.addSubnet(net!, Number(bits ?? (isIPv6(net!) ? 128 : 32)), isIPv6(net!) ? "ipv6" : "ipv4");
  }
  return list.check(ip, isIPv6(ip) ? "ipv6" : "ipv4");
}

/**
 * Report §12.1 optional per-role restrictions. Consistent with the permission union, a user may sign in
 * if at least one of their roles allows it right now. The owner is never restricted (checked by caller).
 */
export function checkLoginRestrictions(a: { roles: RoleRestriction[]; ip: string; now: Date; timezone: string }): "ok" | "ip" | "hours" {
  if (a.roles.length === 0) return "ok";
  let reason: "ip" | "hours" = "hours";
  for (const r of a.roles) {
    if (r.ipAllowlist?.length && !ipAllowed(a.ip, r.ipAllowlist)) {
      reason = "ip";
      continue;
    }
    if (r.loginHours) {
      const { day, hm } = localParts(a.now, a.timezone);
      if (!r.loginHours.days.includes(day) || hm < r.loginHours.from || hm >= r.loginHours.to) {
        reason = "hours";
        continue;
      }
    }
    return "ok";
  }
  return reason;
}
```

`apps/api/src/rbac/actor.ts`:
```ts
import type pg from "pg";
import { effectivePermissions, isPermissionKey, type Actor, type Grant, type Scope } from "@lume/core";

export type ActorRecord = Actor & { restrictions: { loginHours: import("@lume/db").LoginHours | null; ipAllowlist: string[] | null }[] };

/** Everything the permission check and RLS need for one user, in three indexed queries. */
export async function loadActor(pool: pg.Pool, userId: string): Promise<ActorRecord | null> {
  const [u, grants, team] = await Promise.all([
    pool.query("SELECT id, is_owner, totp_enabled, status FROM users WHERE id = $1", [userId]),
    pool.query(
      `SELECT rp.permission_key AS key, rp.scope, r.id AS role_id, r.login_hours, r.ip_allowlist::text[] AS ip_allowlist
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id AND r.deleted_at IS NULL
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         LEFT JOIN permissions p ON p.key = rp.permission_key AND NOT p.retired
        WHERE ur.user_id = $1`,
      [userId],
    ),
    pool.query(
      `SELECT DISTINCT m.user_id FROM team_members lead
         JOIN teams t ON t.id = lead.team_id AND t.deleted_at IS NULL
         JOIN team_members m ON m.team_id = lead.team_id
        WHERE lead.user_id = $1 AND lead.is_lead`,
      [userId],
    ),
  ]);
  const user = u.rows[0];
  if (!user || user.status !== "active") return null;
  const roleIds = new Set<string>();
  const restrictions = new Map<string, ActorRecord["restrictions"][number]>();
  const list: Grant[] = [];
  for (const g of grants.rows as { key: string | null; scope: Scope | null; role_id: string; login_hours: ActorRecord["restrictions"][number]["loginHours"]; ip_allowlist: string[] | null }[]) {
    roleIds.add(g.role_id);
    restrictions.set(g.role_id, { loginHours: g.login_hours, ipAllowlist: g.ip_allowlist });
    if (g.key && isPermissionKey(g.key)) list.push({ key: g.key, scope: g.scope });
  }
  return {
    userId,
    isOwner: user.is_owner,
    perms: effectivePermissions(list),
    teamMemberIds: team.rows.map((r: { user_id: string }) => r.user_id),
    twoFactorEnabled: user.totp_enabled,
    roleIds: [...roleIds],
    restrictions: [...restrictions.values()],
  };
}
```

`apps/api/src/rbac/cache.ts`:
```ts
import type pg from "pg";
import { loadActor, type ActorRecord } from "./actor";

/**
 * Report §7.1: permission changes take effect on the next request. Entries live ≤ 30 s and are dropped the
 * moment any role/user/team change NOTIFYs `lume_rbac`.
 */
export class ActorCache {
  private readonly entries = new Map<string, { at: number; value: ActorRecord | null }>();
  constructor(
    private readonly pool: pg.Pool,
    private readonly ttlMs = 30_000,
    private readonly now = () => Date.now(),
  ) {}

  async get(userId: string): Promise<ActorRecord | null> {
    const hit = this.entries.get(userId);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const value = await loadActor(this.pool, userId);
    this.entries.set(userId, { at: this.now(), value });
    if (this.entries.size > 5000) this.entries.delete(this.entries.keys().next().value!);
    return value;
  }

  invalidate(userId?: string): void {
    if (userId) this.entries.delete(userId);
    else this.entries.clear();
  }
}

/** One dedicated connection LISTENs; payload is a user id, or empty for "everyone" (role/team edits). */
export async function startRbacListener(pool: pg.Pool, cache: ActorCache, onEvent?: () => void): Promise<() => Promise<void>> {
  const client = await pool.connect();
  client.on("notification", (msg) => {
    if (msg.channel !== "lume_rbac") return;
    cache.invalidate(msg.payload || undefined);
    onEvent?.();
  });
  await client.query("LISTEN lume_rbac");
  return async () => {
    await client.query("UNLISTEN lume_rbac").catch(() => undefined);
    client.release();
  };
}
```

`apps/api/src/rbac/notify.ts`:
```ts
import { sql } from "drizzle-orm";
import type { Db } from "../db/context";

/** Delivered on COMMIT only, so a rolled-back change never busts the cache. */
export async function notifyRbac(db: Db, userId?: string): Promise<void> {
  await db.execute(sql`SELECT pg_notify('lume_rbac', ${userId ?? ""})`);
}
```

`apps/api/src/rbac/sync.ts`:
```ts
import type pg from "pg";
import { PERMISSIONS } from "@lume/core";

/** On boot: upsert the code catalog; keys that disappeared are retired, never deleted (roles keep history). */
export async function syncPermissionCatalog(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const p of PERMISSIONS) {
      await client.query(
        `INSERT INTO permissions (key, "group", label, description, supports_scope, retired) VALUES ($1, $2, $3, $4, $5, false)
         ON CONFLICT (key) DO UPDATE SET "group" = EXCLUDED."group", label = EXCLUDED.label, description = EXCLUDED.description,
           supports_scope = EXCLUDED.supports_scope, retired = false`,
        [p.key, p.group, p.label, p.description, p.scoped],
      );
    }
    await client.query("UPDATE permissions SET retired = true WHERE NOT (key = ANY($1::text[]))", [PERMISSIONS.map((p) => p.key)]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
```

`apps/api/src/audit/audit.ts`:
```ts
import type { FastifyRequest } from "fastify";
import { schema } from "@lume/db";

export type AuditEvent = { action: string; entityType: string; entityId?: string | null; diff?: Record<string, unknown>; actorUserId?: string | null };

/** Written in the request's own transaction: if the change rolls back, so does its audit entry. */
export async function audit(req: FastifyRequest, e: AuditEvent): Promise<void> {
  await req.db.insert(schema.auditLog).values({
    actorUserId: e.actorUserId !== undefined ? e.actorUserId : (req.actor?.userId ?? null),
    actorIp: req.ip ?? null,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId ?? null,
    diff: e.diff ?? {},
    requestId: String(req.id),
  });
}
```

`apps/api/src/auth/plugin.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { can, isPermissionKey, requiresTwoFactor, type PermissionKey } from "@lume/core";
import type { Clock } from "../app";
import { forbidden, unauthorized } from "../http/errors";
import type { ActorCache } from "../rbac/cache";
import { SESSION_COOKIE } from "./cookies";
import { assertCsrf } from "./csrf";
import { checkLoginRestrictions } from "./restrictions";
import { readSession, sessionPolicy, type SessionPolicy } from "./sessions";

declare module "fastify" {
  interface FastifyContextConfig {
    permission?: PermissionKey | "auth.self";
    /** Reachable while a mandatory 2FA enrolment is outstanding (enrolment, me, logout). */
    allowDuringEnrolment?: boolean;
    /** Reachable with a password-only (mfa-pending) session: /auth/2fa, /auth/recovery. */
    allowMfaPending?: boolean;
  }
  interface FastifyRequest {
    session: { id: string; stage: "mfa" | "full"; userId: string } | null;
    sessionPolicy: SessionPolicy;
  }
}

type Opts = { pool: pg.Pool; cache: ActorCache; clock: Clock; publicOrigin: string; settings: () => Promise<{ timezone: string; security: import("@lume/db").SecuritySettings } | null> };

/**
 * One onRequest hook, in this order: CSRF → session → actor → restrictions → 2FA gate → permission.
 * Anything not explicitly allowed is refused (fail closed).
 */
export async function authPlugin(app: FastifyInstance, o: Opts): Promise<void> {
  app.decorateRequest("session", null);
  app.decorateRequest("sessionPolicy", null as unknown as SessionPolicy);

  app.addHook("onRequest", async (req) => {
    const cfg = req.routeOptions.config ?? {};
    assertCsrf(req, o.publicOrigin);
    const settings = await o.settings();
    req.sessionPolicy = sessionPolicy(settings?.security);
    const token = req.cookies[SESSION_COOKIE];
    const now = o.clock();
    const s = token ? await readSession(o.pool, token, now, req.sessionPolicy) : null;
    if (s) req.session = { id: s.id, stage: s.stage, userId: s.userId };

    if (cfg.public) {
      if (s?.stage === "full") req.actor = await o.cache.get(s.userId);
      return;
    }
    if (!s) throw unauthorized();
    if (s.stage === "mfa") {
      if (cfg.allowMfaPending) return;
      throw unauthorized("TWO_FACTOR_PENDING", "Enter your two-step code to continue");
    }
    const actor = await o.cache.get(s.userId);
    if (!actor) throw unauthorized();
    req.actor = actor;

    if (!actor.isOwner && settings) {
      const verdict = checkLoginRestrictions({ roles: actor.restrictions, ip: req.ip, now, timezone: settings.timezone });
      if (verdict !== "ok") throw forbidden("LOGIN_RESTRICTED", verdict === "ip" ? "Sign-in isn't allowed from this network" : "Sign-in isn't allowed at this time");
    }
    if (requiresTwoFactor(actor) && !actor.twoFactorEnabled && !cfg.allowDuringEnrolment) {
      throw forbidden("TWO_FACTOR_REQUIRED", "Set up two-step sign-in to continue");
    }
    const p = cfg.permission;
    if (p === "auth.self") return;
    if (!p || !isPermissionKey(p) || !can(actor, p)) throw forbidden();
  });
}
```

Modify `apps/api/src/route-guard.ts`: accept `permission` values `"auth.self"` or any catalog key; reject unknown permission strings at boot (import `isPermissionKey` and add unknown keys to the `missing` list with a note).

Wire up in `apps/api/src/app.ts` `register`:
```ts
      const cache = new ActorCache(deps.pool);
      const stopListener = await startRbacListener(deps.pool, cache, deps.onRbacEvent);
      app.addHook("onClose", stopListener);
      await syncPermissionCatalog(deps.pool);
      const settingsCache = memoSettings(deps.pool); // 5 s memo of { timezone, security }, busted by NOTIFY lume_settings
      await app.register(csrfRoutes, { secure: deps.config.cookieSecure });
      await app.register(authPlugin, { pool: deps.pool, cache, clock: deps.clock, publicOrigin: new URL(deps.config.publicUrl).origin, settings: settingsCache });
      await app.register(dbContext, { pool: deps.pool });
```
(`authPlugin` runs `onRequest`; `dbContext` opens its transaction in `preHandler`, so the actor is known first. Keep that order.)

`memoSettings` (in `apps/api/src/modules/settings/service.ts`):
```ts
import type pg from "pg";
import type { SecuritySettings } from "@lume/db";

export function memoSettings(pool: pg.Pool, ttlMs = 5000) {
  let at = 0;
  let value: { timezone: string; security: SecuritySettings } | null = null;
  return async () => {
    if (Date.now() - at < ttlMs) return value;
    const { rows } = await pool.query("SELECT timezone, security FROM settings WHERE id = 1");
    value = rows[0] ? { timezone: rows[0].timezone, security: rows[0].security } : null;
    at = Date.now();
    return value;
  };
}
```
Add `onRbacEvent?: () => void` to `AppDeps`.

Harness additions (`apps/api/test/harness.ts`):
```ts
  // in createHarness, before buildApp:
  await ownerPool.query(
    "INSERT INTO settings (business_name, timezone, currency, default_country_iso, industry_preset) VALUES ('Test Co', 'Asia/Dubai', 'AED', 'AE', 'general')",
  );
  let rbacEvents = 0;
  // pass onRbacEvent: () => void rbacEvents++ to buildApp
```
Methods:
```ts
    async seedUser(o = {}) {
      const id = newId();
      const email = o.email ?? `u-${id.slice(-8)}@test.lume`;
      const password = "correct horse battery staple";
      const hash = await hashPassword(password, { memoryCost: 1024, timeCost: 1, parallelism: 1 });
      const totpSecret = o.totp ? newTotpSecret() : undefined;
      await ownerPool.query(
        "INSERT INTO users (id, email, name, password_hash, status, is_owner, totp_enabled, totp_secret_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [id, email, o.name ?? "Test User", hash, o.status ?? "active", o.owner ?? false, Boolean(totpSecret), totpSecret ? keyring.encrypt(totpSecret, `totp:${id}`) : null],
      );
      if (o.grants?.length || o.grants?.length === 0) {
        const roleId = newId();
        await ownerPool.query("INSERT INTO roles (id, name) VALUES ($1, $2)", [roleId, `role-${roleId.slice(-8)}`]);
        for (const g of o.grants ?? []) await ownerPool.query("INSERT INTO role_permissions VALUES ($1, $2, $3)", [roleId, g.key, g.scope]);
        await ownerPool.query("INSERT INTO user_roles VALUES ($1, $2)", [id, roleId]);
      }
      return { id, email, password, totpSecret };
    },
    async signIn(user) {
      // Mint a full session directly (auth routes are tested separately in Task 9).
      const token = randomToken();
      await ownerPool.query("INSERT INTO sessions (id, user_id, stage, expires_at, created_at, last_seen_at) VALUES ($1, $2, 'full', $3, $4, $4)", [
        sha256Hex(token), user.id, new Date(clock.now.getTime() + 7 * 24 * 3600_000), clock.now,
      ]);
      const csrf = await this.csrf();
      const cookies = { ...csrf.cookies, "__Host-lume_session": token };
      return {
        cookies,
        headers: csrf.headers,
        inject: (req) => app.inject({ ...req, cookies: { ...cookies, ...req.cookies }, headers: { ...csrf.headers, ...req.headers } }),
      };
    },
    async grant(userId, grants) {
      const roleId = newId();
      await ownerPool.query("INSERT INTO roles (id, name) VALUES ($1, $2)", [roleId, `role-${roleId.slice(-8)}`]);
      for (const g of grants) await ownerPool.query("INSERT INTO role_permissions VALUES ($1, $2, $3)", [roleId, g.key, g.scope]);
      await ownerPool.query("INSERT INTO user_roles VALUES ($1, $2)", [userId, roleId]);
      await ownerPool.query("SELECT pg_notify('lume_rbac', $1)", [userId]);
    },
    async waitForRbacNotify() {
      const start = rbacEvents;
      for (let i = 0; i < 100 && rbacEvents === start; i++) await new Promise((r) => setTimeout(r, 20));
    },
    async seedTeam(leadId, memberIds) {
      const teamId = newId();
      await ownerPool.query("INSERT INTO teams (id, name) VALUES ($1, $2)", [teamId, `team-${teamId.slice(-8)}`]);
      await ownerPool.query("INSERT INTO team_members (team_id, user_id, is_lead) VALUES ($1, $2, true)", [teamId, leadId]);
      for (const m of memberIds) await ownerPool.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)", [teamId, m]);
      return teamId;
    },
```
Because the first test's `signIn` inserts a session via the owner pool, `sessions` rows need `lume_app` access too. Default privileges already grant it (0002).

- [ ] **Step 4: Run to verify they pass**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/api && pnpm typecheck && pnpm lint'`
Expected: restrictions (4), auth (6) and all earlier API tests pass.

- [ ] **Step 5: Commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(api): CSRF, server-side sessions, NOTIFY-busted actor cache, fail-closed auth plugin, audit writer

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 8: Login throttling and lockout

**Files:**
- Create: `apps/api/src/auth/throttle.ts`, `apps/api/src/auth/throttle.test.ts`

**Interfaces:**
- Produces:
  - `THROTTLE = { windowMs: 15 min, accountLockAfter: 10, ipLockAfter: 50, lockMs: 15 min, freeFailures: 2, maxDelayS: 30 }`
  - pure `nextOnFailure(state, now, lockAfter): ThrottleState`, `verdict(state, now): { allowed: true } | { allowed: false; retryAfterSec; locked: boolean }`
  - DB: `checkThrottle(db, keys, now)`, `recordFailure(db, key, lockAfter, now): Promise<{ lockedNow: boolean; lockouts: number }>`, `clearThrottle(db, key)`
  - `accountKey(email) = "acct:" + sha256(lower(email))`, `ipKey(ip) = "ip:" + ip`

- [ ] **Step 1: Write the failing test**

`apps/api/src/auth/throttle.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { THROTTLE, accountKey, nextOnFailure, verdict, type ThrottleState } from "./throttle";

const t0 = new Date("2026-09-21T09:00:00Z");
const plus = (ms: number) => new Date(t0.getTime() + ms);
const fresh = (): ThrottleState => ({ failures: 0, windowStartedAt: t0, nextAllowedAt: null, lockedUntil: null, lockouts: 0 });

describe("login throttle (report §12.1: progressive delay, 15-min lockout after 10)", () => {
  it("lets the first two failures through freely, then delays 1, 2, 4 … s (capped at 30)", () => {
    let s = fresh();
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      s = nextOnFailure(s, t0, THROTTLE.accountLockAfter);
      delays.push(s.nextAllowedAt ? (s.nextAllowedAt.getTime() - t0.getTime()) / 1000 : 0);
    }
    expect(delays).toEqual([0, 0, 1, 2, 4, 8, 16, 30, 30]);
  });

  it("locks for 15 minutes at the 10th failure, then allows again", () => {
    let s = fresh();
    for (let i = 0; i < 10; i++) s = nextOnFailure(s, t0, THROTTLE.accountLockAfter);
    expect(s.lockedUntil?.getTime()).toBe(plus(THROTTLE.lockMs).getTime());
    expect(s.lockouts).toBe(1);
    expect(verdict(s, plus(60_000))).toEqual({ allowed: false, retryAfterSec: 840, locked: true });
    expect(verdict(s, plus(THROTTLE.lockMs + 1))).toEqual({ allowed: true });
  });

  it("forgets failures once the window has passed", () => {
    let s = fresh();
    for (let i = 0; i < 5; i++) s = nextOnFailure(s, t0, THROTTLE.accountLockAfter);
    s = nextOnFailure(s, plus(THROTTLE.windowMs + 1), THROTTLE.accountLockAfter);
    expect(s.failures).toBe(1);
  });

  it("keys accounts by a hash of the normalised email (unknown emails throttle identically)", () => {
    expect(accountKey(" Tasneem@Nupuur.com ")).toBe(accountKey("tasneem@nupuur.com"));
    expect(accountKey("x@y.z")).toMatch(/^acct:[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/dev.sh run pnpm vitest run apps/api/src/auth/throttle.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`apps/api/src/auth/throttle.ts`:
```ts
import { eq, inArray, sql } from "drizzle-orm";
import { sha256Hex } from "@lume/core";
import { schema } from "@lume/db";
import type { Db } from "../db/context";

export const THROTTLE = { windowMs: 15 * 60_000, accountLockAfter: 10, ipLockAfter: 50, lockMs: 15 * 60_000, freeFailures: 2, maxDelayS: 30 } as const;
export type ThrottleState = { failures: number; windowStartedAt: Date; nextAllowedAt: Date | null; lockedUntil: Date | null; lockouts: number };

export const accountKey = (email: string) => `acct:${sha256Hex(email.trim().toLowerCase())}`;
export const ipKey = (ip: string) => `ip:${ip}`;

export function nextOnFailure(s: ThrottleState, now: Date, lockAfter: number): ThrottleState {
  const expired = now.getTime() - s.windowStartedAt.getTime() > THROTTLE.windowMs;
  const failures = (expired ? 0 : s.failures) + 1;
  const windowStartedAt = expired ? now : s.windowStartedAt;
  if (failures >= lockAfter) {
    return { failures: 0, windowStartedAt: now, nextAllowedAt: null, lockedUntil: new Date(now.getTime() + THROTTLE.lockMs), lockouts: s.lockouts + 1 };
  }
  const over = failures - THROTTLE.freeFailures;
  const delayS = over > 0 ? Math.min(THROTTLE.maxDelayS, 2 ** (over - 1)) : 0;
  return { failures, windowStartedAt, nextAllowedAt: delayS ? new Date(now.getTime() + delayS * 1000) : null, lockedUntil: s.lockedUntil, lockouts: s.lockouts };
}

export function verdict(s: ThrottleState, now: Date): { allowed: true } | { allowed: false; retryAfterSec: number; locked: boolean } {
  if (s.lockedUntil && s.lockedUntil > now) return { allowed: false, retryAfterSec: Math.ceil((s.lockedUntil.getTime() - now.getTime()) / 1000), locked: true };
  if (s.nextAllowedAt && s.nextAllowedAt > now) return { allowed: false, retryAfterSec: Math.ceil((s.nextAllowedAt.getTime() - now.getTime()) / 1000), locked: false };
  return { allowed: true };
}

export async function checkThrottle(db: Db, keys: string[], now: Date) {
  const rows = await db.select().from(schema.authThrottle).where(inArray(schema.authThrottle.key, keys));
  for (const r of rows) {
    const v = verdict(r, now);
    if (!v.allowed) return v;
  }
  return { allowed: true } as const;
}

export async function recordFailure(db: Db, key: string, lockAfter: number, now: Date): Promise<{ lockedNow: boolean; lockouts: number }> {
  // Row lock so concurrent failures can't both read the same count.
  await db.insert(schema.authThrottle).values({ key, windowStartedAt: now }).onConflictDoNothing();
  const [cur] = await db.select().from(schema.authThrottle).where(eq(schema.authThrottle.key, key)).for("update");
  const next = nextOnFailure(cur!, now, lockAfter);
  await db.update(schema.authThrottle).set(next).where(eq(schema.authThrottle.key, key));
  return { lockedNow: next.lockouts > cur!.lockouts, lockouts: next.lockouts };
}

export async function clearThrottle(db: Db, key: string): Promise<void> {
  await db.update(schema.authThrottle).set({ failures: 0, nextAllowedAt: null, windowStartedAt: sql`now()` }).where(eq(schema.authThrottle.key, key));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `scripts/dev.sh run pnpm vitest run apps/api/src/auth/throttle.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(api): progressive login throttling and 15-minute lockout keyed by IP and hashed email

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 9: Setup wizard API and sign-in routes

**Files:**
- Create: `apps/api/src/modules/setup/{routes.ts,service.ts}`, `apps/api/src/modules/auth/{routes.ts,service.ts}`, `apps/api/src/crypto/keyring-store.ts`, `apps/api/src/modules/setup/setup.test.ts`, `apps/api/src/modules/auth/login.test.ts`
- Modify: `apps/api/src/app.ts` (register modules), `apps/api/src/main.ts` (real deps)

**Interfaces:**
- Produces:
  - `GET /api/v1/setup/status` → `{ needsSetup: boolean }`
  - `POST /api/v1/setup/totp` `{ token }` → `{ secret, otpauthUri }`
  - `POST /api/v1/setup` `{ token, business: { name, timezone, currency, defaultCountry }, preset: "coaching" | "general", owner: { name, email, password }, totp: { secret, code } }` → `201 { recoveryCodes: string[] }` plus a session cookie
  - `POST /api/v1/auth/login` `{ email, password }` → `{ next: "otp" | "done" }` · `401 INVALID_CREDENTIALS` · `429 TOO_MANY_ATTEMPTS` · `403 LOGIN_RESTRICTED`
  - `POST /api/v1/auth/2fa` `{ code }` → `{ next: "done" }` · `401 INVALID_CODE`
  - `POST /api/v1/auth/recovery` `{ code }` → `{ next: "done", remaining: number }`
  - `POST /api/v1/auth/logout` → 204
  - `GET /api/v1/auth/me` → `{ user: { id, name, email, isOwner, theme, timezone }, permissions: { key, scope }[], twoFactor: { enabled, required } }`
  - `loadKeyring(pool, master): Promise<Keyring>`, which creates the first data key if none exists
  - `setupService.applyPreset` hook: `(tx, preset) => Promise<void>`, a no-op in 1A that 1B fills

- [ ] **Step 1: Write the failing tests**

`apps/api/src/modules/setup/setup.test.ts`:
```ts
import { totpCode } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ noSettings: true }); // a pristine installation
});
afterAll(async () => h.close());

const body = (secret: string, code: string, token = h.setupToken) => ({
  token,
  business: { name: "Nupuur Coaching", timezone: "Asia/Dubai", currency: "AED", defaultCountry: "AE" },
  preset: "coaching",
  owner: { name: "Nupuur Patil", email: "nupuur@nupuur.com", password: "a long and lovely passphrase" },
  totp: { secret, code },
});

describe("first-run setup (report §15.3)", () => {
  it("reports that setup is needed", async () => {
    expect((await h.app.inject({ method: "GET", url: "/api/v1/setup/status" })).json()).toEqual({ needsSetup: true });
  });

  it("refuses a wrong token and a wrong two-step code", async () => {
    const c = await h.csrf();
    const t = await h.app.inject({ method: "POST", url: "/api/v1/setup/totp", payload: { token: h.setupToken }, ...c });
    const { secret } = t.json();
    expect((await h.app.inject({ method: "POST", url: "/api/v1/setup", payload: body(secret, totpCode(secret, h.clock.now.getTime()), "wrong"), ...c })).statusCode).toBe(403);
    expect((await h.app.inject({ method: "POST", url: "/api/v1/setup", payload: body(secret, "000000"), ...c })).json().error.code).toBe("INVALID_CODE");
  });

  it("creates settings, the owner with 2FA, default roles, recovery codes and a session, once", async () => {
    const c = await h.csrf();
    const { secret } = (await h.app.inject({ method: "POST", url: "/api/v1/setup/totp", payload: { token: h.setupToken }, ...c })).json();
    const res = await h.app.inject({ method: "POST", url: "/api/v1/setup", payload: body(secret, totpCode(secret, h.clock.now.getTime())), ...c });
    expect(res.statusCode).toBe(201);
    expect(res.json().recoveryCodes).toHaveLength(10);
    expect(res.cookies.some((x) => x.name === "__Host-lume_session" && x.httpOnly && x.secure && x.sameSite === "Lax")).toBe(true);
    const { rows } = await h.pool.query("SELECT is_owner, totp_enabled, status FROM users");
    expect(rows).toEqual([{ is_owner: true, totp_enabled: true, status: "active" }]);
    expect((await h.pool.query("SELECT name FROM roles ORDER BY name")).rows.map((r) => r.name)).toEqual(["Admin", "Sales"]);
    expect((await h.pool.query("SELECT action FROM audit_log WHERE action = 'setup.completed'")).rowCount).toBe(1);
    // token is burned; a second setup is impossible
    expect((await h.app.inject({ method: "GET", url: "/api/v1/setup/status" })).json()).toEqual({ needsSetup: false });
    expect((await h.app.inject({ method: "POST", url: "/api/v1/setup", payload: body(secret, totpCode(secret, h.clock.now.getTime())), ...c })).statusCode).toBe(403);
  });
});
```

`apps/api/src/modules/auth/login.test.ts`:
```ts
import { totpCode } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

async function login(email: string, password: string) {
  const c = await h.csrf();
  const res = await h.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password }, ...c });
  const session = res.cookies.find((x) => x.name === "__Host-lume_session")?.value;
  return { res, c, session };
}

describe("POST /auth/login (report §12.1)", () => {
  it("signs in without 2FA and returns next: done", async () => {
    const u = await h.seedUser({ grants: [] });
    const { res, session } = await login(u.email, u.password);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ next: "done" });
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    const u = await h.seedUser({ grants: [] });
    const a = await login(u.email, "not the password at all");
    const b = await login("nobody@nowhere.test", "not the password at all");
    expect(a.res.statusCode).toBe(401);
    expect(b.res.statusCode).toBe(401);
    expect(a.res.json()).toEqual(b.res.json());
    expect(a.res.json().error.code).toBe("INVALID_CREDENTIALS");
  });

  it("requires the TOTP code when 2FA is on, and refuses replays", async () => {
    const u = await h.seedUser({ grants: [], totp: true });
    const { res, c, session } = await login(u.email, u.password);
    expect(res.json()).toEqual({ next: "otp" });
    const cookies = { ...c.cookies, "__Host-lume_session": session! };
    // a pending (mfa) session can't reach normal routes
    expect((await h.app.inject({ method: "GET", url: "/api/v1/auth/me", cookies })).statusCode).toBe(401);
    const code = totpCode(u.totpSecret!, h.clock.now.getTime());
    const ok = await h.app.inject({ method: "POST", url: "/api/v1/auth/2fa", payload: { code }, headers: c.headers, cookies });
    expect(ok.statusCode).toBe(200);
    const full = ok.cookies.find((x) => x.name === "__Host-lume_session")!.value;
    expect(full).not.toBe(session); // rotated on privilege change
    expect((await h.app.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { ...c.cookies, "__Host-lume_session": full } })).statusCode).toBe(200);
    // same code again (new login) is rejected: replay
    const again = await login(u.email, u.password);
    const replay = await h.app.inject({ method: "POST", url: "/api/v1/auth/2fa", payload: { code }, headers: again.c.headers, cookies: { ...again.c.cookies, "__Host-lume_session": again.session! } });
    expect(replay.json().error.code).toBe("INVALID_CODE");
  });

  it("locks the account after 10 failures and says so with Retry-After", async () => {
    const u = await h.seedUser({ grants: [] });
    let last;
    for (let i = 0; i < 12; i++) {
      last = (await login(u.email, `wrong-${i}-xxxxxxxx`)).res;
      h.clock.advance(31_000); // step past the progressive delay
    }
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers["retry-after"])).toBeGreaterThan(0);
    expect((await login(u.email, u.password)).res.statusCode).toBe(429); // even the right password waits
    expect((await h.pool.query("SELECT count(*)::int n FROM audit_log WHERE action = 'user.login.locked'")).rows[0].n).toBe(1);
  });

  it("logout revokes the session", async () => {
    const u = await h.seedUser({ grants: [] });
    const { c, session } = await login(u.email, u.password);
    const cookies = { ...c.cookies, "__Host-lume_session": session! };
    expect((await h.app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: c.headers, cookies })).statusCode).toBe(204);
    expect((await h.app.inject({ method: "GET", url: "/api/v1/auth/me", cookies })).statusCode).toBe(401);
  });

  it("/auth/me reports permissions and whether 2FA is required", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [{ key: "leads.view", scope: "team" }] }));
    const me = (await c.inject({ method: "GET", url: "/api/v1/auth/me" })).json();
    expect(me.permissions).toEqual([{ key: "leads.view", scope: "team" }]);
    expect(me.twoFactor).toEqual({ enabled: false, required: false });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `scripts/dev.sh run pnpm vitest run apps/api/src/modules`
Expected: FAIL, modules not found. Also add `noSettings?: boolean` to `createHarness` options (skip the settings insert).

- [ ] **Step 3: Implement**

`apps/api/src/crypto/keyring-store.ts`:
```ts
import type pg from "pg";
import { Keyring, newStoredKey } from "@lume/core";

/** Loads every data key; on a fresh database creates the first one. */
export async function loadKeyring(pool: pg.Pool, master: Buffer): Promise<Keyring> {
  const { rows } = await pool.query("SELECT id, wrapped, active FROM crypto_keys");
  if (rows.length === 0) {
    const k = newStoredKey(master);
    await pool.query("INSERT INTO crypto_keys (id, wrapped, active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING", [k.id, k.wrapped]);
    return loadKeyring(pool, master);
  }
  return Keyring.create(master, rows);
}
```

`apps/api/src/modules/auth/service.ts`:
```ts
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { hashPassword, hashRecoveryCode, needsRehash, normalizeRecoveryCode, verifyPassword, verifyTotp } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { setSessionCookie } from "../../auth/cookies";
import { THROTTLE, accountKey, checkThrottle, clearThrottle, ipKey, recordFailure } from "../../auth/throttle";
import { createSession, revokeSession } from "../../auth/sessions";
import { tooMany } from "../../http/errors";

type Deps = Pick<AppDeps, "clock" | "keyring" | "argon2" | "config">;
let dummyHash: Promise<string> | null = null;
const INVALID = { error: { code: "INVALID_CREDENTIALS", message: "That email and password don't match." } };

export async function login(req: FastifyRequest, reply: FastifyReply, d: Deps, email: string, password: string) {
  const now = d.clock();
  const keys = [accountKey(email), ipKey(req.ip)];
  const gate = await checkThrottle(req.db, keys, now);
  if (!gate.allowed) throw tooMany(gate.retryAfterSec);

  const [user] = await req.db.select().from(schema.users).where(eq(schema.users.email, email.trim()));
  // Constant work whether or not the account exists: verify against a dummy hash for unknown emails.
  dummyHash ??= hashPassword("lume-dummy-password-for-timing", d.argon2);
  const ok = await verifyPassword(user?.passwordHash ?? (await dummyHash), password);
  if (!user || !ok || user.status !== "active") {
    const acct = await recordFailure(req.db, keys[0]!, THROTTLE.accountLockAfter, now);
    await recordFailure(req.db, keys[1]!, THROTTLE.ipLockAfter, now);
    await audit(req, { action: acct.lockedNow ? "user.login.locked" : "user.login.failed", entityType: "user", entityId: user?.id ?? null, actorUserId: null, diff: {} });
    return reply.code(401).send(INVALID);
  }
  await clearThrottle(req.db, keys[0]!);
  if (needsRehash(user.passwordHash!, d.argon2)) {
    await req.db.update(schema.users).set({ passwordHash: await hashPassword(password, d.argon2) }).where(eq(schema.users.id, user.id));
  }
  const stage = user.totpEnabled ? "mfa" : "full";
  const s = await createSession(req.db, { userId: user.id, stage, ip: req.ip, userAgent: req.headers["user-agent"] ?? null, now, policy: req.sessionPolicy });
  setSessionCookie(reply, s.token, s.expiresAt, d.config.cookieSecure);
  if (stage === "full") await req.db.update(schema.users).set({ lastLoginAt: now }).where(eq(schema.users.id, user.id));
  await audit(req, { action: stage === "full" ? "user.login" : "user.login.password_ok", entityType: "user", entityId: user.id, actorUserId: user.id });
  return { next: stage === "full" ? ("done" as const) : ("otp" as const) };
}

async function upgradeToFull(req: FastifyRequest, reply: FastifyReply, d: Deps, userId: string) {
  const now = d.clock();
  await revokeSession(req.db, req.session!.id, "mfa_completed", now);
  const s = await createSession(req.db, { userId, stage: "full", ip: req.ip, userAgent: req.headers["user-agent"] ?? null, now, policy: req.sessionPolicy });
  setSessionCookie(reply, s.token, s.expiresAt, d.config.cookieSecure);
  await req.db.update(schema.users).set({ lastLoginAt: now }).where(eq(schema.users.id, userId));
}

export async function secondFactor(req: FastifyRequest, reply: FastifyReply, d: Deps, code: string) {
  const s = req.session;
  if (!s || s.stage !== "mfa") return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue" } });
  const now = d.clock();
  const gate = await checkThrottle(req.db, [`mfa:${s.userId}`], now);
  if (!gate.allowed) throw tooMany(gate.retryAfterSec);
  const [user] = await req.db.select().from(schema.users).where(eq(schema.users.id, s.userId)).for("update");
  const secret = d.keyring.decrypt(user!.totpSecretEnc!, `totp:${user!.id}`);
  const step = verifyTotp(secret, code, { nowMs: now.getTime(), lastUsedStep: user!.totpLastStep });
  if (step === null) {
    await recordFailure(req.db, `mfa:${s.userId}`, THROTTLE.accountLockAfter, now);
    await audit(req, { action: "user.2fa.failed", entityType: "user", entityId: s.userId, actorUserId: s.userId });
    return reply.code(401).send({ error: { code: "INVALID_CODE", message: "That code didn't work." } });
  }
  await req.db.update(schema.users).set({ totpLastStep: step }).where(eq(schema.users.id, s.userId));
  await upgradeToFull(req, reply, d, s.userId);
  await audit(req, { action: "user.login", entityType: "user", entityId: s.userId, actorUserId: s.userId, diff: { method: "totp" } });
  return { next: "done" as const };
}

export async function recoveryCode(req: FastifyRequest, reply: FastifyReply, d: Deps, code: string) {
  const s = req.session;
  if (!s || s.stage !== "mfa") return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue" } });
  const now = d.clock();
  const gate = await checkThrottle(req.db, [`mfa:${s.userId}`], now);
  if (!gate.allowed) throw tooMany(gate.retryAfterSec);
  const hash = hashRecoveryCode(normalizeRecoveryCode(code));
  const used = await req.db
    .update(schema.recoveryCodes)
    .set({ usedAt: now })
    .where(and(eq(schema.recoveryCodes.userId, s.userId), eq(schema.recoveryCodes.codeHash, hash), isNull(schema.recoveryCodes.usedAt)))
    .returning({ id: schema.recoveryCodes.id });
  if (used.length === 0) {
    await recordFailure(req.db, `mfa:${s.userId}`, THROTTLE.accountLockAfter, now);
    return reply.code(401).send({ error: { code: "INVALID_CODE", message: "That code didn't work." } });
  }
  await upgradeToFull(req, reply, d, s.userId);
  const remaining = (await req.db.select().from(schema.recoveryCodes).where(and(eq(schema.recoveryCodes.userId, s.userId), isNull(schema.recoveryCodes.usedAt)))).length;
  await audit(req, { action: "user.login", entityType: "user", entityId: s.userId, actorUserId: s.userId, diff: { method: "recovery_code", remaining } });
  return { next: "done" as const, remaining };
}
```

`apps/api/src/modules/auth/routes.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requiresTwoFactor } from "@lume/core";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { clearSessionCookie } from "../../auth/cookies";
import { revokeSession } from "../../auth/sessions";
import { login, recoveryCode, secondFactor } from "./service";

const email = z.email().max(254);

export async function authRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post("/api/v1/auth/login", { config: { public: true }, schema: { body: z.object({ email, password: z.string().min(1).max(256) }) } }, (req, reply) =>
    login(req, reply, d, req.body.email, req.body.password),
  );
  r.post("/api/v1/auth/2fa", { config: { public: true }, schema: { body: z.object({ code: z.string().regex(/^\d{6}$/) }) } }, (req, reply) =>
    secondFactor(req, reply, d, req.body.code),
  );
  r.post("/api/v1/auth/recovery", { config: { public: true }, schema: { body: z.object({ code: z.string().min(10).max(20) }) } }, (req, reply) =>
    recoveryCode(req, reply, d, req.body.code),
  );
  r.post("/api/v1/auth/logout", { config: { permission: "auth.self", allowDuringEnrolment: true } }, async (req, reply) => {
    await revokeSession(req.db, req.session!.id, "logout", d.clock());
    await audit(req, { action: "user.logout", entityType: "user", entityId: req.actor!.userId });
    clearSessionCookie(reply, d.config.cookieSecure);
    return reply.code(204).send();
  });
  r.get("/api/v1/auth/me", { config: { permission: "auth.self", allowDuringEnrolment: true } }, async (req) => {
    const a = req.actor!;
    const { rows } = await d.pool.query("SELECT id, name, email, is_owner, theme, timezone FROM users WHERE id = $1", [a.userId]);
    const u = rows[0];
    return {
      user: { id: u.id, name: u.name, email: u.email, isOwner: u.is_owner, theme: u.theme, timezone: u.timezone },
      permissions: [...a.perms.entries()].map(([key, scope]) => ({ key, scope: scope === true ? null : scope })).sort((x, y) => x.key.localeCompare(y.key)),
      twoFactor: { enabled: a.twoFactorEnabled, required: requiresTwoFactor(a) },
    };
  });
}
```

`apps/api/src/modules/setup/service.ts`:
```ts
import { sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { DEFAULT_ROLES, generateRecoveryCodes, hashPassword, hashRecoveryCode, newId, passwordProblems, safeEqual, verifyTotp } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { setSessionCookie } from "../../auth/cookies";
import { createSession } from "../../auth/sessions";
import type { Db } from "../../db/context";
import { badRequest, forbidden } from "../../http/errors";
import { notifyRbac } from "../../rbac/notify";

export type SetupInput = {
  token: string;
  business: { name: string; timezone: string; currency: string; defaultCountry: string };
  preset: "coaching" | "general";
  owner: { name: string; email: string; password: string };
  totp: { secret: string; code: string };
};

/** Phase 1B registers pipeline/field/template seeding here; it runs inside the setup transaction. */
export const presetAppliers: Array<(db: Db, preset: SetupInput["preset"]) => Promise<void>> = [];

function assertToken(d: AppDeps, token: string) {
  const current = d.setupTokens.current();
  if (!current || !safeEqual(current, token)) throw forbidden("SETUP_TOKEN", "That setup token isn't valid");
}

export async function runSetup(req: FastifyRequest, reply: FastifyReply, d: AppDeps, input: SetupInput) {
  assertToken(d, input.token);
  const now = d.clock();
  const problems = passwordProblems(input.owner.password, { email: input.owner.email, isBreached: d.isBreached });
  if (problems.length) throw badRequest("WEAK_PASSWORD", "Choose a stronger password", { problems });
  if (verifyTotp(input.totp.secret, input.totp.code, { nowMs: now.getTime() }) === null) {
    return reply.code(400).send({ error: { code: "INVALID_CODE", message: "That code didn't work. Check the time on your phone." } });
  }
  // Serialise concurrent setups; then prove nobody finished first.
  await req.db.execute(sql`SELECT pg_advisory_xact_lock(4242)`);
  const existing = await req.db.execute(sql`SELECT 1 FROM users LIMIT 1`);
  if (existing.rows.length) throw forbidden("SETUP_TOKEN", "LUME is already set up");

  await req.db.insert(schema.settings).values({
    businessName: input.business.name,
    timezone: input.business.timezone,
    currency: input.business.currency,
    defaultCountryIso: input.business.defaultCountry,
    industryPreset: input.preset,
  });
  const ownerId = newId();
  await req.db.insert(schema.users).values({
    id: ownerId,
    email: input.owner.email,
    name: input.owner.name,
    passwordHash: await hashPassword(input.owner.password, d.argon2),
    status: "active",
    isOwner: true,
    timezone: input.business.timezone,
    totpEnabled: true,
    totpSecretEnc: d.keyring.encrypt(input.totp.secret, `totp:${ownerId}`),
    lastLoginAt: now,
  });
  for (const role of DEFAULT_ROLES) {
    const roleId = newId();
    await req.db.insert(schema.roles).values({ id: roleId, name: role.name, description: role.description, color: role.color, createdBy: ownerId });
    await req.db.insert(schema.rolePermissions).values(role.grants.map((g) => ({ roleId, permissionKey: g.key, scope: g.scope })));
    if (role.name === "Admin") await req.db.insert(schema.userRoles).values({ userId: ownerId, roleId });
  }
  const codes = generateRecoveryCodes();
  await req.db.insert(schema.recoveryCodes).values(codes.map((c) => ({ id: newId(), userId: ownerId, codeHash: hashRecoveryCode(c) })));
  for (const apply of presetAppliers) await apply(req.db, input.preset);
  const s = await createSession(req.db, { userId: ownerId, stage: "full", ip: req.ip, userAgent: req.headers["user-agent"] ?? null, now, policy: req.sessionPolicy });
  setSessionCookie(reply, s.token, s.expiresAt, d.config.cookieSecure);
  await audit(req, { action: "setup.completed", entityType: "settings", entityId: "1", actorUserId: ownerId, diff: { preset: input.preset } });
  await notifyRbac(req.db);
  d.setupTokens.burn();
  return reply.code(201).send({ recoveryCodes: codes });
}
```

`apps/api/src/modules/setup/routes.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { newTotpSecret, otpauthUri, safeEqual } from "@lume/core";
import type { AppDeps } from "../../app";
import { forbidden } from "../../http/errors";
import { runSetup } from "./service";

const tz = z.string().refine((v) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}, "unknown timezone");

export async function setupRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/setup/status", { config: { public: true } }, async () => {
    const { rows } = await d.pool.query("SELECT EXISTS (SELECT 1 FROM users) AS has_users");
    return { needsSetup: !rows[0].has_users && d.setupTokens.current() !== null };
  });
  r.post("/api/v1/setup/totp", { config: { public: true }, schema: { body: z.object({ token: z.string().min(16).max(128) }) } }, async (req) => {
    const current = d.setupTokens.current();
    if (!current || !safeEqual(current, req.body.token)) throw forbidden("SETUP_TOKEN", "That setup token isn't valid");
    const secret = newTotpSecret();
    return { secret, otpauthUri: otpauthUri({ secret, account: "owner", issuer: "LUME" }) };
  });
  r.post(
    "/api/v1/setup",
    {
      config: { public: true },
      schema: {
        body: z.object({
          token: z.string().min(16).max(128),
          business: z.object({ name: z.string().trim().min(1).max(120), timezone: tz, currency: z.string().regex(/^[A-Z]{3}$/), defaultCountry: z.string().regex(/^[A-Z]{2}$/) }),
          preset: z.enum(["coaching", "general"]),
          owner: z.object({ name: z.string().trim().min(1).max(120), email: z.email().max(254), password: z.string().min(1).max(256) }),
          totp: z.object({ secret: z.string().regex(/^[A-Z2-7]{32}$/), code: z.string().regex(/^\d{6}$/) }),
        }),
      },
    },
    (req, reply) => runSetup(req, reply, d, req.body),
  );
}
```

Register in `apps/api/src/app.ts` `register` (after `dbContext`):
```ts
      await app.register(setupRoutes, deps);
      await app.register(authRoutes, deps);
```

`apps/api/src/main.ts`: build real deps:
```ts
import pg from "pg";
import { ARGON2_PRODUCTION, loadBreachedChecker, masterKeyFromBase64 } from "@lume/core";
import { apiSchema, loadConfig } from "@lume/config";
import { buildApp } from "./app";
import { processSetupTokens } from "./auth/setup-token";
import { loadKeyring } from "./crypto/keyring-store";
import { REDACT_PATHS } from "./logger";
import { createMailer } from "./mail/mailer";

const cfg = loadConfig(apiSchema);
const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL_APP, max: 10 });
const logger = { level: cfg.LOG_LEVEL, redact: { paths: REDACT_PATHS, censor: "[redacted]" } };
const { rows } = await pool.query("SELECT EXISTS (SELECT 1 FROM users) AS has_users");
const app = await buildApp({
  pool,
  keyring: await loadKeyring(pool, masterKeyFromBase64(cfg.LUME_MASTER_KEY)),
  mailer: createMailer(cfg.SMTP_URL, cfg.MAIL_FROM ?? `LUME <no-reply@${cfg.LUME_PUBLIC_HOST}>`),
  config: { publicUrl: cfg.LUME_PUBLIC_URL, cookieSecure: true },
  clock: () => new Date(),
  setupTokens: processSetupTokens(!rows[0].has_users, (m) => console.log(m)),
  isBreached: await loadBreachedChecker(cfg.BREACHED_LIST_FILE),
  argon2: ARGON2_PRODUCTION,
  logger,
});
await app.listen({ host: "0.0.0.0", port: cfg.API_PORT });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
```
Update `infra/docker/api.Dockerfile` runtime stage: `COPY --from=build /src/packages/core/data ./data`.

- [ ] **Step 4: Run to verify they pass**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/api && pnpm typecheck && pnpm lint'`
Expected: setup (3) and login (6) pass with everything else.

- [ ] **Step 5: Commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(api): first-run setup with mandatory owner 2FA, login with constant-time failures, TOTP + recovery codes

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 10: Me — sessions, two-factor enrolment, profile

**Files:**
- Create: `apps/api/src/modules/me/{routes.ts,service.ts}`, `apps/api/src/modules/me/me.test.ts`

**Interfaces:**
- Produces (all `auth.self`; the 2FA ones set `allowDuringEnrolment`):
  - `GET /me/sessions` → `{ sessions: { id, current, ip, userAgent, createdAt, lastSeenAt }[] }`
  - `DELETE /me/sessions/:id` → 204. `:id` is the first 16 hex characters of the session id, never the full hash.
  - `POST /me/2fa/enrol` → `{ secret, otpauthUri }` (stored encrypted as pending)
  - `POST /me/2fa/confirm { code }` → `{ recoveryCodes }`. This enables 2FA, rotates the session, and revokes other sessions.
  - `POST /me/2fa/disable { password }` → 204. Refused (`403 TWO_FACTOR_REQUIRED`) if the user's roles require it.
  - `POST /me/recovery-codes { password }` → `{ recoveryCodes }`, replacing all old codes
  - `PATCH /me { name?, timezone?, theme? }` → the updated profile

- [ ] **Step 1: Write the failing test**

`apps/api/src/modules/me/me.test.ts`:
```ts
import { totpCode } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

describe("/me", () => {
  it("lists my sessions without exposing their ids and lets me revoke another one", async () => {
    const u = await h.seedUser({ grants: [] });
    const a = await h.signIn(u);
    const b = await h.signIn(u);
    const list = (await a.inject({ method: "GET", url: "/api/v1/me/sessions" })).json().sessions;
    expect(list).toHaveLength(2);
    expect(list.every((s: { id: string }) => /^[0-9a-f]{16}$/.test(s.id))).toBe(true);
    const other = list.find((s: { current: boolean }) => !s.current);
    expect((await a.inject({ method: "DELETE", url: `/api/v1/me/sessions/${other.id}` })).statusCode).toBe(204);
    expect((await b.inject({ method: "GET", url: "/api/v1/me/sessions" })).statusCode).toBe(401);
  });

  it("a user whose role requires 2FA can enrol (and only enrol) until done", async () => {
    const u = await h.seedUser({ grants: [{ key: "users.manage", scope: null }] });
    const c = await h.signIn(u);
    expect((await c.inject({ method: "GET", url: "/api/v1/me/sessions" })).statusCode).toBe(403);
    const { secret, otpauthUri } = (await c.inject({ method: "POST", url: "/api/v1/me/2fa/enrol" })).json();
    expect(otpauthUri).toContain(encodeURIComponent(u.email));
    const bad = await c.inject({ method: "POST", url: "/api/v1/me/2fa/confirm", payload: { code: "000000" } });
    expect(bad.statusCode).toBe(400);
    const ok = await c.inject({ method: "POST", url: "/api/v1/me/2fa/confirm", payload: { code: totpCode(secret, h.clock.now.getTime()) } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().recoveryCodes).toHaveLength(10);
    const rotated = ok.cookies.find((x) => x.name === "__Host-lume_session")!.value;
    const again = await c.inject({ method: "GET", url: "/api/v1/me/sessions", cookies: { "__Host-lume_session": rotated } });
    expect(again.statusCode).toBe(200);
  });

  it("refuses to switch off 2FA when a role requires it", async () => {
    const u = await h.seedUser({ grants: [{ key: "roles.manage", scope: null }], totp: true });
    const c = await h.signIn(u);
    const r = await c.inject({ method: "POST", url: "/api/v1/me/2fa/disable", payload: { password: u.password } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("TWO_FACTOR_REQUIRED");
  });

  it("updates my name, timezone and theme, validating each", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [] }));
    const ok = await c.inject({ method: "PATCH", url: "/api/v1/me", payload: { name: "Riya", timezone: "Asia/Kolkata", theme: "obsidian" } });
    expect(ok.json()).toMatchObject({ name: "Riya", timezone: "Asia/Kolkata", theme: "obsidian" });
    expect((await c.inject({ method: "PATCH", url: "/api/v1/me", payload: { timezone: "Mars/Olympus" } })).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/dev.sh run pnpm vitest run apps/api/src/modules/me`
Expected: FAIL, 404s (routes missing).

- [ ] **Step 3: Implement**

`apps/api/src/modules/me/service.ts`:
```ts
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { generateRecoveryCodes, hashRecoveryCode, newId, newTotpSecret, otpauthUri, requiresTwoFactor, verifyPassword, verifyTotp } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { setSessionCookie } from "../../auth/cookies";
import { createSession, revokeSession, revokeUserSessions } from "../../auth/sessions";
import { badRequest, forbidden, notFound, unauthorized } from "../../http/errors";
import { notifyRbac } from "../../rbac/notify";

export async function listSessions(req: FastifyRequest) {
  const rows = await req.db
    .select()
    .from(schema.sessions)
    .where(and(eq(schema.sessions.userId, req.actor!.userId), isNull(schema.sessions.revokedAt), eq(schema.sessions.stage, "full")));
  return {
    sessions: rows
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
      .map((s) => ({ id: s.id.slice(0, 16), current: s.id === req.session!.id, ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt })),
  };
}

export async function revokeMine(req: FastifyRequest, d: AppDeps, shortId: string) {
  const rows = await req.db.select({ id: schema.sessions.id }).from(schema.sessions).where(and(eq(schema.sessions.userId, req.actor!.userId), isNull(schema.sessions.revokedAt)));
  const match = rows.filter((r) => r.id.startsWith(shortId));
  if (match.length !== 1) throw notFound();
  await revokeSession(req.db, match[0]!.id, "revoked_by_user", d.clock());
  await audit(req, { action: "session.revoked", entityType: "user", entityId: req.actor!.userId });
}

export async function beginEnrolment(req: FastifyRequest, d: AppDeps) {
  const [u] = await req.db.select().from(schema.users).where(eq(schema.users.id, req.actor!.userId));
  const secret = newTotpSecret();
  await req.db.update(schema.users).set({ totpPendingEnc: d.keyring.encrypt(secret, `totp-pending:${u!.id}`) }).where(eq(schema.users.id, u!.id));
  const [s] = await req.db.select({ name: schema.settings.businessName }).from(schema.settings);
  return { secret, otpauthUri: otpauthUri({ secret, account: u!.email, issuer: `LUME · ${s?.name ?? "LUME"}` }) };
}

export async function confirmEnrolment(req: FastifyRequest, reply: FastifyReply, d: AppDeps, code: string) {
  const now = d.clock();
  const [u] = await req.db.select().from(schema.users).where(eq(schema.users.id, req.actor!.userId)).for("update");
  if (!u!.totpPendingEnc) throw badRequest("NO_ENROLMENT", "Start two-step setup first");
  const secret = d.keyring.decrypt(u!.totpPendingEnc, `totp-pending:${u!.id}`);
  const step = verifyTotp(secret, code, { nowMs: now.getTime() });
  if (step === null) throw badRequest("INVALID_CODE", "That code didn't work. Check the time on your phone.");
  await req.db
    .update(schema.users)
    .set({ totpEnabled: true, totpSecretEnc: d.keyring.encrypt(secret, `totp:${u!.id}`), totpPendingEnc: null, totpLastStep: step })
    .where(eq(schema.users.id, u!.id));
  const codes = await replaceRecoveryCodes(req, u!.id);
  // Privilege changed: rotate this session and end all others.
  await revokeUserSessions(req.db, u!.id, "2fa_enabled", now, req.session!.id);
  await revokeSession(req.db, req.session!.id, "rotated", now);
  const s = await createSession(req.db, { userId: u!.id, stage: "full", ip: req.ip, userAgent: req.headers["user-agent"] ?? null, now, policy: req.sessionPolicy });
  setSessionCookie(reply, s.token, s.expiresAt, d.config.cookieSecure);
  await audit(req, { action: "user.2fa.enabled", entityType: "user", entityId: u!.id });
  await notifyRbac(req.db, u!.id);
  return { recoveryCodes: codes };
}

async function replaceRecoveryCodes(req: FastifyRequest, userId: string): Promise<string[]> {
  await req.db.delete(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, userId));
  const codes = generateRecoveryCodes();
  await req.db.insert(schema.recoveryCodes).values(codes.map((c) => ({ id: newId(), userId, codeHash: hashRecoveryCode(c) })));
  return codes;
}

async function assertPassword(req: FastifyRequest, password: string) {
  const [u] = await req.db.select().from(schema.users).where(eq(schema.users.id, req.actor!.userId));
  if (!u?.passwordHash || !(await verifyPassword(u.passwordHash, password))) throw unauthorized("INVALID_CREDENTIALS", "That password isn't right");
}

export async function disableTwoFactor(req: FastifyRequest, password: string) {
  if (requiresTwoFactor(req.actor!)) throw forbidden("TWO_FACTOR_REQUIRED", "Your role requires two-step sign-in");
  await assertPassword(req, password);
  await req.db.update(schema.users).set({ totpEnabled: false, totpSecretEnc: null, totpPendingEnc: null, totpLastStep: null }).where(eq(schema.users.id, req.actor!.userId));
  await req.db.delete(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, req.actor!.userId));
  await audit(req, { action: "user.2fa.disabled", entityType: "user", entityId: req.actor!.userId });
  await notifyRbac(req.db, req.actor!.userId);
}

export async function regenerateRecoveryCodes(req: FastifyRequest, password: string) {
  await assertPassword(req, password);
  const codes = await replaceRecoveryCodes(req, req.actor!.userId);
  await audit(req, { action: "user.recovery_codes.regenerated", entityType: "user", entityId: req.actor!.userId });
  return { recoveryCodes: codes };
}

export async function updateProfile(req: FastifyRequest, patch: { name?: string; timezone?: string; theme?: "system" | "porcelain" | "obsidian" }) {
  const [u] = await req.db.update(schema.users).set(patch).where(eq(schema.users.id, req.actor!.userId)).returning();
  await audit(req, { action: "user.profile.updated", entityType: "user", entityId: u!.id, diff: { fields: Object.keys(patch) } });
  return { id: u!.id, name: u!.name, email: u!.email, timezone: u!.timezone, theme: u!.theme };
}
```

`apps/api/src/modules/me/routes.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import * as me from "./service";

const self = { permission: "auth.self" as const };
const enrol = { permission: "auth.self" as const, allowDuringEnrolment: true };
export const timezoneSchema = z.string().refine((v) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}, "unknown timezone");

export async function meRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/me/sessions", { config: self }, (req) => me.listSessions(req));
  r.delete("/api/v1/me/sessions/:id", { config: self, schema: { params: z.object({ id: z.string().regex(/^[0-9a-f]{16}$/) }) } }, async (req, reply) => {
    await me.revokeMine(req, d, req.params.id);
    return reply.code(204).send();
  });
  r.post("/api/v1/me/2fa/enrol", { config: enrol }, (req) => me.beginEnrolment(req, d));
  r.post("/api/v1/me/2fa/confirm", { config: enrol, schema: { body: z.object({ code: z.string().regex(/^\d{6}$/) }) } }, (req, reply) =>
    me.confirmEnrolment(req, reply, d, req.body.code),
  );
  r.post("/api/v1/me/2fa/disable", { config: self, schema: { body: z.object({ password: z.string().min(1).max(256) }) } }, async (req, reply) => {
    await me.disableTwoFactor(req, req.body.password);
    return reply.code(204).send();
  });
  r.post("/api/v1/me/recovery-codes", { config: self, schema: { body: z.object({ password: z.string().min(1).max(256) }) } }, (req) =>
    me.regenerateRecoveryCodes(req, req.body.password),
  );
  r.patch(
    "/api/v1/me",
    {
      config: self,
      schema: {
        body: z.object({ name: z.string().trim().min(1).max(120).optional(), timezone: timezoneSchema.optional(), theme: z.enum(["system", "porcelain", "obsidian"]).optional() }).strict(),
      },
    },
    (req) => me.updateProfile(req, req.body),
  );
}
```
Register `meRoutes` in `app.ts`. Harness: make `signIn`'s returned `inject` merge an explicit `cookies` override, so the test can pass the rotated cookie.

- [ ] **Step 4: Run to verify it passes**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/api && pnpm typecheck && pnpm lint'`
Expected: me (4) passes with the rest.

- [ ] **Step 5: Commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(api): my sessions, two-factor enrolment with rotation, recovery codes, profile

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 11: Mail, invites, password reset (+ Mailpit)

**Files:**
- Create: `apps/api/src/mail/mailer.ts`, `apps/api/src/mail/templates.ts`, `apps/api/src/modules/invites/{routes.ts,service.ts}`, `apps/api/src/modules/auth/password.ts`, `apps/api/src/modules/invites/invites.test.ts`, `apps/api/src/mail/templates.test.ts`
- Modify: `infra/compose.dev.yml` (Mailpit), `infra/docker-compose.yml` (api env), `infra/.env.example`, `apps/api/src/modules/auth/routes.ts`, `apps/api/src/app.ts`

**Interfaces:**
- Produces:
  - `type OutgoingMail = { to: string; subject: string; text: string; html: string; kind: "invite" | "password_reset" | "lockout" }`
  - `type Mailer = { send(m: OutgoingMail): Promise<void> }`
  - `createMailer(smtpUrl, from)`, falling back to a logging no-op mailer when `smtpUrl` is undefined
  - `inviteMail`, `resetMail`, `lockoutMail` template functions
  - `POST /invites` (users.manage) `{ email, name, roleIds }` → `201 { invite: { id, email, expiresAt }, url }`
  - `GET /invites/:token` (public) → `{ email, name, businessName }`, or 404
  - `POST /invites/:token/accept` (public) `{ password }` → 201 plus a session cookie
  - `POST /auth/password/forgot` (public) `{ email }` → always 202
  - `POST /auth/password/reset` (public) `{ token, password }` → 204, which revokes every session for that user

- [ ] **Step 1: Mailpit on the dev stack**

Add to `infra/compose.dev.yml`:
```yaml
  mailpit:
    image: axllent/mailpit:latest
    restart: unless-stopped
    networks: [backend]
    ports: ["127.0.0.1:8025:8025"] # web inbox via the SSH tunnel; SMTP stays internal on :1025
    mem_limit: 64m
    cpus: 0.1
  api:
    environment:
      SMTP_URL: smtp://mailpit:1025
      LUME_PUBLIC_URL: https://lume.localhost:8443
```
In `infra/docker-compose.yml` api `environment` add `LUME_PUBLIC_URL: ${LUME_PUBLIC_URL:?}`, `SMTP_URL: ${SMTP_URL:-}` and `MAIL_FROM: ${MAIL_FROM:-}`. Add `LUME_PUBLIC_URL=https://nupuur.example.com`, `SMTP_URL=` and `MAIL_FROM=` to `infra/.env.example`. Add `LUME_PUBLIC_URL=https://lume.localhost:8443` to `gen-dev-env.sh`'s output. For the existing dev `.env`, append the line once with `scripts/dev.sh remote "grep -q LUME_PUBLIC_URL /root/lume-dev/.env || echo LUME_PUBLIC_URL=https://lume.localhost:8443 >> /root/lume-dev/.env"`. Extend `scripts/dev.sh tunnel` to also forward `-L 8025:127.0.0.1:8025`.

- [ ] **Step 2: Write the failing tests**

`apps/api/src/mail/templates.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { inviteMail, resetMail } from "./templates";

describe("mail templates", () => {
  it("escapes names and never includes anything but the link", () => {
    const m = inviteMail({ to: "r@x.com", name: "<script>Riya</script>", businessName: "Nupuur & Co", inviterName: "Tasneem", url: "https://lume.test/invite/abc", expiresAt: new Date("2026-09-24T09:00:00Z") });
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;Riya&lt;/script&gt;");
    expect(m.html).toContain("Nupuur &amp; Co");
    expect(m.text).toContain("https://lume.test/invite/abc");
    expect(m.subject).toBe("Tasneem invited you to LUME for Nupuur & Co");
  });

  it("reset mail says it expires in 30 minutes", () => {
    expect(resetMail({ to: "a@b.c", businessName: "X", url: "https://lume.test/reset/t" }).text).toMatch(/30 minutes/);
  });
});
```

`apps/api/src/modules/invites/invites.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

const tokenFrom = (url: string) => url.split("/").pop()!;

describe("invites (report §12.1: invite-only, single-use, 72 h)", () => {
  it("an admin invites, the invitee accepts once, and lands signed in with the right roles", async () => {
    const admin = await h.signIn(await h.seedUser({ grants: [{ key: "users.manage", scope: null }], totp: true }));
    const { rows: [role] } = await h.pool.query("INSERT INTO roles (id, name) VALUES (gen_random_uuid(), 'Sales') RETURNING id");
    const res = await admin.inject({ method: "POST", url: "/api/v1/invites", payload: { email: "riya@nupuur.com", name: "Riya", roleIds: [role.id] } });
    expect(res.statusCode).toBe(201);
    expect(h.mail.at(-1)).toMatchObject({ to: "riya@nupuur.com", kind: "invite" });
    const token = tokenFrom(res.json().url);

    expect((await h.app.inject({ method: "GET", url: `/api/v1/invites/${token}` })).json()).toMatchObject({ email: "riya@nupuur.com", name: "Riya" });
    const c = await h.csrf();
    const weak = await h.app.inject({ method: "POST", url: `/api/v1/invites/${token}/accept`, payload: { password: "short" }, ...c });
    expect(weak.json().error.code).toBe("WEAK_PASSWORD");
    const ok = await h.app.inject({ method: "POST", url: `/api/v1/invites/${token}/accept`, payload: { password: "a long and lovely passphrase" }, ...c });
    expect(ok.statusCode).toBe(201);
    expect(ok.cookies.some((x) => x.name === "__Host-lume_session")).toBe(true);
    const { rows } = await h.pool.query("SELECT u.status, ur.role_id FROM users u JOIN user_roles ur ON ur.user_id = u.id WHERE u.email = 'riya@nupuur.com'");
    expect(rows).toEqual([{ status: "active", role_id: role.id }]);
    // single use
    expect((await h.app.inject({ method: "POST", url: `/api/v1/invites/${token}/accept`, payload: { password: "a long and lovely passphrase" }, ...c })).statusCode).toBe(404);
  });

  it("expired invites are gone", async () => {
    const admin = await h.signIn(await h.seedUser({ grants: [{ key: "users.manage", scope: null }], totp: true }));
    const res = await admin.inject({ method: "POST", url: "/api/v1/invites", payload: { email: "late@nupuur.com", name: "Late", roleIds: [] } });
    h.clock.advance(72 * 3600_000 + 1);
    expect((await h.app.inject({ method: "GET", url: `/api/v1/invites/${tokenFrom(res.json().url)}` })).statusCode).toBe(404);
  });

  it("cannot invite someone who already has an account", async () => {
    const existing = await h.seedUser({ grants: [] });
    const admin = await h.signIn(await h.seedUser({ grants: [{ key: "users.manage", scope: null }], totp: true }));
    const res = await admin.inject({ method: "POST", url: "/api/v1/invites", payload: { email: existing.email, name: "Dup", roleIds: [] } });
    expect(res.statusCode).toBe(409);
  });
});

describe("password reset (report §12.1: emailed single-use token, 30 min)", () => {
  it("never reveals whether an email exists, and resets + signs out everywhere", async () => {
    const u = await h.seedUser({ grants: [] });
    const session = await h.signIn(u);
    const c = await h.csrf();
    const before = h.mail.length;
    expect((await h.app.inject({ method: "POST", url: "/api/v1/auth/password/forgot", payload: { email: "ghost@nowhere.test" }, ...c })).statusCode).toBe(202);
    expect(h.mail.length).toBe(before);
    expect((await h.app.inject({ method: "POST", url: "/api/v1/auth/password/forgot", payload: { email: u.email }, ...c })).statusCode).toBe(202);
    const token = tokenFrom(/https:\/\/lume\.test\/reset\/\S+/.exec(h.mail.at(-1)!.text)![0]);
    const ok = await h.app.inject({ method: "POST", url: "/api/v1/auth/password/reset", payload: { token, password: "an entirely new passphrase" }, ...c });
    expect(ok.statusCode).toBe(204);
    expect((await session.inject({ method: "GET", url: "/api/v1/auth/me" })).statusCode).toBe(401);
    expect((await h.app.inject({ method: "POST", url: "/api/v1/auth/password/reset", payload: { token, password: "yet another passphrase!!" }, ...c })).statusCode).toBe(400);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `scripts/dev.sh add --filter @lume/api nodemailer && scripts/dev.sh add --filter @lume/api -D @types/nodemailer && scripts/dev.sh run pnpm vitest run apps/api/src/mail apps/api/src/modules/invites`
Expected: FAIL.

- [ ] **Step 4: Implement**

`apps/api/src/mail/mailer.ts`:
```ts
import nodemailer from "nodemailer";

export type OutgoingMail = { to: string; subject: string; text: string; html: string; kind: "invite" | "password_reset" | "lockout" };
export type Mailer = { send(m: OutgoingMail): Promise<void> };

/** Without SMTP_URL mail is not sent (and nothing sensitive is logged); invite links are still shown to the admin. */
export function createMailer(smtpUrl: string | undefined, from: string): Mailer {
  if (!smtpUrl) return { send: async (m) => console.warn(JSON.stringify({ level: "warn", msg: "mail not configured", kind: m.kind })) };
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    send: async (m) => {
      await transport.sendMail({ from, to: m.to, subject: m.subject, text: m.text, html: m.html });
    },
  };
}
```

`apps/api/src/mail/templates.ts`:
```ts
import type { OutgoingMail } from "./mailer";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Emails carry names and links only, never lead data (report §10.7). Plain layout that survives every client. */
function layout(title: string, body: string, cta: { label: string; url: string }): string {
  return `<!doctype html><html><body style="margin:0;background:#EEF0F3;font-family:-apple-system,Segoe UI,Inter,sans-serif;color:#0A0C11">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;padding:32px">
<tr><td style="font-weight:760;letter-spacing:.14em;font-size:15px">LUME</td></tr>
<tr><td style="padding-top:20px;font-size:20px;font-weight:650">${title}</td></tr>
<tr><td style="padding-top:10px;font-size:15px;line-height:1.5;color:#5A606D">${body}</td></tr>
<tr><td style="padding-top:24px"><a href="${esc(cta.url)}" style="display:inline-block;background:#2A5BFF;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px">${esc(cta.label)}</a></td></tr>
</table></td></tr></table></body></html>`;
}

export function inviteMail(a: { to: string; name: string; businessName: string; inviterName: string; url: string; expiresAt: Date }): OutgoingMail {
  const subject = `${a.inviterName} invited you to LUME for ${a.businessName}`;
  const text = `Hi ${a.name},\n\n${a.inviterName} invited you to ${a.businessName} on LUME.\n\nAccept the invite (valid for 72 hours): ${a.url}\n\nIf you weren't expecting this, you can ignore this email.`;
  const html = layout(`You're invited to ${esc(a.businessName)}`, `Hi ${esc(a.name)}, ${esc(a.inviterName)} invited you to work in LUME. The link is valid for 72 hours.`, { label: "Accept invite", url: a.url });
  return { to: a.to, subject, text, html, kind: "invite" };
}

export function resetMail(a: { to: string; businessName: string; url: string }): OutgoingMail {
  const text = `Someone asked to reset your LUME password for ${a.businessName}.\n\nReset it here (valid for 30 minutes): ${a.url}\n\nIf this wasn't you, ignore this email; your password stays the same.`;
  return { to: a.to, subject: "Reset your LUME password", text, html: layout("Reset your password", "This link is valid for 30 minutes. If you didn't ask for it, ignore this email.", { label: "Choose a new password", url: a.url }), kind: "password_reset" };
}

export function lockoutMail(a: { to: string; businessName: string; lockedEmailHint: string; url: string }): OutgoingMail {
  const text = `An account (${a.lockedEmailHint}) at ${a.businessName} was locked for 15 minutes after repeated failed sign-ins.\n\nReview activity: ${a.url}`;
  return { to: a.to, subject: "LUME: an account was locked after failed sign-ins", text, html: layout("An account was locked", `${esc(a.lockedEmailHint)} was locked for 15 minutes after repeated failed sign-ins.`, { label: "Review activity", url: a.url }), kind: "lockout" };
}
```

`apps/api/src/modules/invites/service.ts`:
```ts
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { hashPassword, newId, passwordProblems, randomToken, sha256Hex } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { setSessionCookie } from "../../auth/cookies";
import { createSession } from "../../auth/sessions";
import { badRequest, conflict, notFound } from "../../http/errors";
import { inviteMail } from "../../mail/templates";

const TTL_MS = 72 * 3600_000;

export async function createInvite(req: FastifyRequest, d: AppDeps, a: { email: string; name: string; roleIds: string[] }) {
  const now = d.clock();
  const [existing] = await req.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, a.email));
  if (existing) throw conflict("USER_EXISTS", "That person already has an account");
  if (a.roleIds.length) {
    const found = await req.db.select({ id: schema.roles.id }).from(schema.roles).where(and(inArray(schema.roles.id, a.roleIds), isNull(schema.roles.deletedAt)));
    if (found.length !== new Set(a.roleIds).size) throw badRequest("UNKNOWN_ROLE", "One of those roles doesn't exist");
  }
  const token = randomToken();
  const id = newId();
  const expiresAt = new Date(now.getTime() + TTL_MS);
  await req.db.insert(schema.userInvites).values({ id, email: a.email, name: a.name, roleIds: a.roleIds, tokenHash: sha256Hex(token), expiresAt, invitedBy: req.actor!.userId, createdAt: now });
  const url = `${d.config.publicUrl}/invite/${token}`;
  const [inviter] = await req.db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, req.actor!.userId));
  const [s] = await req.db.select({ name: schema.settings.businessName }).from(schema.settings);
  await d.mailer.send(inviteMail({ to: a.email, name: a.name, businessName: s?.name ?? "LUME", inviterName: inviter?.name ?? "Someone", url, expiresAt }));
  await audit(req, { action: "user.invited", entityType: "invite", entityId: id, diff: { roleIds: a.roleIds } });
  return { invite: { id, email: a.email, expiresAt }, url };
}

async function liveInvite(req: FastifyRequest, d: AppDeps, token: string) {
  const [inv] = await req.db
    .select()
    .from(schema.userInvites)
    .where(and(eq(schema.userInvites.tokenHash, sha256Hex(token)), isNull(schema.userInvites.acceptedAt), isNull(schema.userInvites.revokedAt), gt(schema.userInvites.expiresAt, d.clock())))
    .for("update");
  if (!inv) throw notFound();
  return inv;
}

export async function peekInvite(req: FastifyRequest, d: AppDeps, token: string) {
  const inv = await liveInvite(req, d, token);
  const [s] = await req.db.select({ name: schema.settings.businessName }).from(schema.settings);
  return { email: inv.email, name: inv.name, businessName: s?.name ?? "LUME" };
}

export async function acceptInvite(req: FastifyRequest, reply: FastifyReply, d: AppDeps, token: string, password: string) {
  const now = d.clock();
  const inv = await liveInvite(req, d, token);
  const problems = passwordProblems(password, { email: inv.email, isBreached: d.isBreached });
  if (problems.length) throw badRequest("WEAK_PASSWORD", "Choose a stronger password", { problems });
  const [dup] = await req.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, inv.email));
  if (dup) throw conflict("USER_EXISTS", "That person already has an account");
  const userId = newId();
  await req.db.insert(schema.users).values({ id: userId, email: inv.email, name: inv.name, passwordHash: await hashPassword(password, d.argon2), status: "active", lastLoginAt: now });
  if (inv.roleIds.length) await req.db.insert(schema.userRoles).values(inv.roleIds.map((roleId) => ({ userId, roleId })));
  await req.db.update(schema.userInvites).set({ acceptedAt: now }).where(eq(schema.userInvites.id, inv.id));
  const s = await createSession(req.db, { userId, stage: "full", ip: req.ip, userAgent: req.headers["user-agent"] ?? null, now, policy: req.sessionPolicy });
  setSessionCookie(reply, s.token, s.expiresAt, d.config.cookieSecure);
  await audit(req, { action: "user.invite.accepted", entityType: "user", entityId: userId, actorUserId: userId, diff: { inviteId: inv.id } });
  return reply.code(201).send({ userId });
}
```

`apps/api/src/modules/invites/routes.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { acceptInvite, createInvite, peekInvite } from "./service";

const token = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

export async function inviteRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.post(
    "/api/v1/invites",
    { config: { permission: "users.manage" }, schema: { body: z.object({ email: z.email().max(254), name: z.string().trim().min(1).max(120), roleIds: z.array(z.uuid()).max(20) }) } },
    async (req, reply) => reply.code(201).send(await createInvite(req, d, req.body)),
  );
  r.get("/api/v1/invites/:token", { config: { public: true }, schema: { params: token } }, (req) => peekInvite(req, d, req.params.token));
  r.post("/api/v1/invites/:token/accept", { config: { public: true }, schema: { params: token, body: z.object({ password: z.string().min(1).max(256) }) } }, (req, reply) =>
    acceptInvite(req, reply, d, req.params.token, req.body.password),
  );
}
```

`apps/api/src/modules/auth/password.ts`:
```ts
import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { hashPassword, newId, passwordProblems, randomToken, sha256Hex } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { revokeUserSessions } from "../../auth/sessions";
import { badRequest } from "../../http/errors";
import { resetMail } from "../../mail/templates";

/** Always the same response: whether the email exists is never revealed. */
export async function forgotPassword(req: FastifyRequest, d: AppDeps, email: string): Promise<void> {
  const now = d.clock();
  const [u] = await req.db.select().from(schema.users).where(eq(schema.users.email, email.trim()));
  if (!u || u.status !== "active") return;
  const token = randomToken();
  await req.db.insert(schema.passwordResets).values({ id: newId(), userId: u.id, tokenHash: sha256Hex(token), expiresAt: new Date(now.getTime() + 30 * 60_000), createdAt: now });
  const [s] = await req.db.select({ name: schema.settings.businessName }).from(schema.settings);
  await d.mailer.send(resetMail({ to: u.email, businessName: s?.name ?? "LUME", url: `${d.config.publicUrl}/reset/${token}` }));
  await audit(req, { action: "user.password.reset_requested", entityType: "user", entityId: u.id, actorUserId: null });
}

export async function resetPassword(req: FastifyRequest, d: AppDeps, token: string, password: string): Promise<void> {
  const now = d.clock();
  const [r] = await req.db
    .select()
    .from(schema.passwordResets)
    .where(and(eq(schema.passwordResets.tokenHash, sha256Hex(token)), isNull(schema.passwordResets.usedAt), gt(schema.passwordResets.expiresAt, now)))
    .for("update");
  if (!r) throw badRequest("INVALID_TOKEN", "That reset link has expired. Ask for a new one.");
  const [u] = await req.db.select().from(schema.users).where(eq(schema.users.id, r.userId));
  const problems = passwordProblems(password, { email: u!.email, isBreached: d.isBreached });
  if (problems.length) throw badRequest("WEAK_PASSWORD", "Choose a stronger password", { problems });
  await req.db.update(schema.users).set({ passwordHash: await hashPassword(password, d.argon2), mustChangePassword: false }).where(eq(schema.users.id, u!.id));
  await req.db.update(schema.passwordResets).set({ usedAt: now }).where(eq(schema.passwordResets.id, r.id));
  await revokeUserSessions(req.db, u!.id, "password_reset", now);
  await audit(req, { action: "user.password.reset", entityType: "user", entityId: u!.id, actorUserId: u!.id });
}
```
Add to `authRoutes`:
```ts
  r.post("/api/v1/auth/password/forgot", { config: { public: true }, schema: { body: z.object({ email }) } }, async (req, reply) => {
    await forgotPassword(req, d, req.body.email);
    return reply.code(202).send();
  });
  r.post(
    "/api/v1/auth/password/reset",
    { config: { public: true }, schema: { body: z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), password: z.string().min(1).max(256) }) } },
    async (req, reply) => {
      await resetPassword(req, d, req.body.token, req.body.password);
      return reply.code(204).send();
    },
  );
```
Lockout mail: in `login()` (Task 9), when `acct.lockedNow`, look up users holding `security.manage` or the owner, and send `lockoutMail` to each, with `lockedEmailHint` = first char + `•••@` + domain. Emails are rate-limited by only sending when `acct.lockouts` changes, which is already the case. Register `inviteRoutes` in `app.ts`.

- [ ] **Step 5: Run to verify they pass**

Run: `scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile >/dev/null && pnpm vitest run apps/api && pnpm typecheck && pnpm lint'`
Expected: templates (2), invites (3) and reset (1) pass with the rest.

- [ ] **Step 6: Commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(api): invite-only onboarding, password reset that signs out everywhere, mail via SMTP/Mailpit

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 12: Users, roles, teams, settings and audit admin APIs

**Files:**
- Create: `apps/api/src/modules/users/{routes.ts,service.ts,users.test.ts}`, `apps/api/src/modules/roles/{routes.ts,service.ts,roles.test.ts}`, `apps/api/src/modules/teams/{routes.ts,service.ts,teams.test.ts}`, `apps/api/src/modules/settings/routes.ts`, `apps/api/src/modules/audit/{routes.ts,audit.test.ts}`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Produces:
  - `GET /users` (users.manage) → `{ users: { id, name, email, status, isOwner, twoFactor, lastLoginAt, roles: { id, name }[] }[] }`
  - `PATCH /users/:id` `{ name?, roleIds? }`
  - `POST /users/:id/disable`, `POST /users/:id/enable`, `DELETE /users/:id/sessions`
  - `GET /permissions` (roles.manage) → the catalog, grouped
  - `GET /roles`, `POST /roles` `{ name, description?, color?, grants: { key, scope? }[], loginHours?, ipAllowlist? }`
  - `GET /roles/:id`, `PATCH /roles/:id`, `DELETE /roles/:id` `{ replacementRoleId? }`, `POST /roles/:id/clone` `{ name }`
  - `GET /teams`, `POST /teams` `{ name }`, `PATCH /teams/:id` `{ name }`, `DELETE /teams/:id`, `PUT /teams/:id/members` `{ members: { userId, isLead }[] }`
  - `GET /settings` (auth.self) → `{ businessName, timezone, currency, defaultCountry, weekStart, industryPreset }`
  - `PATCH /settings` (settings.manage)
  - `GET /audit` (audit.view) `?cursor&limit&action&actorUserId&entityType&entityId` → `{ entries, nextCursor }`
  - Owner protections: nobody can disable, demote or remove roles from the owner, and the owner can't be disabled by anyone
  - All mutations audited, and RBAC-affecting ones `notifyRbac`

- [ ] **Step 1: Write the failing tests**

`apps/api/src/modules/users/users.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";

let h: Harness;
let admin: Awaited<ReturnType<Harness["signIn"]>>;
beforeAll(async () => {
  h = await createHarness();
  admin = await h.signIn(await h.seedUser({ grants: [{ key: "users.manage", scope: null }], totp: true }));
});
afterAll(async () => h.close());

describe("users admin", () => {
  it("disabling a user kills every session they have (report §12.1)", async () => {
    const u = await h.seedUser({ grants: [] });
    const s1 = await h.signIn(u);
    const s2 = await h.signIn(u);
    expect((await admin.inject({ method: "POST", url: `/api/v1/users/${u.id}/disable` })).statusCode).toBe(204);
    expect((await s1.inject({ method: "GET", url: "/api/v1/auth/me" })).statusCode).toBe(401);
    expect((await s2.inject({ method: "GET", url: "/api/v1/auth/me" })).statusCode).toBe(401);
    expect((await h.pool.query("SELECT action FROM audit_log WHERE action = 'user.disabled' AND entity_id = $1", [u.id])).rowCount).toBe(1);
  });

  it("nobody can disable or demote the owner", async () => {
    const owner = await h.seedUser({ owner: true, totp: true });
    expect((await admin.inject({ method: "POST", url: `/api/v1/users/${owner.id}/disable` })).json().error.code).toBe("OWNER_PROTECTED");
    expect((await admin.inject({ method: "PATCH", url: `/api/v1/users/${owner.id}`, payload: { roleIds: [] } })).json().error.code).toBe("OWNER_PROTECTED");
  });

  it("changing someone's roles takes effect on their next request", async () => {
    const u = await h.seedUser({ grants: [] });
    const s = await h.signIn(u);
    const { rows: [role] } = await h.pool.query("INSERT INTO roles (id, name) VALUES (gen_random_uuid(), 'Viewer') RETURNING id");
    await h.pool.query("INSERT INTO role_permissions VALUES ($1, 'audit.view', NULL)", [role.id]);
    expect((await s.inject({ method: "GET", url: "/api/v1/audit" })).statusCode).toBe(403);
    await admin.inject({ method: "PATCH", url: `/api/v1/users/${u.id}`, payload: { roleIds: [role.id] } });
    await h.waitForRbacNotify();
    expect((await s.inject({ method: "GET", url: "/api/v1/audit" })).statusCode).toBe(200);
  });
});
```

`apps/api/src/modules/roles/roles.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";

let h: Harness;
let admin: Awaited<ReturnType<Harness["signIn"]>>;
beforeAll(async () => {
  h = await createHarness();
  admin = await h.signIn(await h.seedUser({ grants: [{ key: "roles.manage", scope: null }], totp: true }));
});
afterAll(async () => h.close());

describe("roles admin (report §7.1)", () => {
  it("creates a role; scopes are only accepted on scoped permissions", async () => {
    const ok = await admin.inject({
      method: "POST",
      url: "/api/v1/roles",
      payload: { name: "Team lead", grants: [{ key: "leads.view", scope: "team" }, { key: "templates.use" }] },
    });
    expect(ok.statusCode).toBe(201);
    const bad = await admin.inject({ method: "POST", url: "/api/v1/roles", payload: { name: "Odd", grants: [{ key: "templates.use", scope: "all" }] } });
    expect(bad.json().error.code).toBe("SCOPE_NOT_SUPPORTED");
    const unknown = await admin.inject({ method: "POST", url: "/api/v1/roles", payload: { name: "Odd2", grants: [{ key: "leads.steal" }] } });
    expect(unknown.statusCode).toBe(400);
  });

  it("deleting a role that people hold requires a replacement, moved in the same transaction", async () => {
    const holder = await h.seedUser({ grants: [{ key: "templates.use", scope: null }] });
    const { rows: [held] } = await h.pool.query("SELECT role_id FROM user_roles WHERE user_id = $1", [holder.id]);
    expect((await admin.inject({ method: "DELETE", url: `/api/v1/roles/${held.role_id}`, payload: {} })).json().error.code).toBe("REPLACEMENT_REQUIRED");
    const { json } = await admin.inject({ method: "POST", url: "/api/v1/roles", payload: { name: "Fallback", grants: [] } });
    const replacement = json().role.id;
    expect((await admin.inject({ method: "DELETE", url: `/api/v1/roles/${held.role_id}`, payload: { replacementRoleId: replacement } })).statusCode).toBe(204);
    expect((await h.pool.query("SELECT role_id FROM user_roles WHERE user_id = $1", [holder.id])).rows).toEqual([{ role_id: replacement }]);
  });

  it("clones a role with all its grants", async () => {
    const { json } = await admin.inject({ method: "POST", url: "/api/v1/roles", payload: { name: "Source", grants: [{ key: "leads.view", scope: "own" }] } });
    const clone = await admin.inject({ method: "POST", url: `/api/v1/roles/${json().role.id}/clone`, payload: { name: "Source copy" } });
    expect(clone.json().role.grants).toEqual([{ key: "leads.view", scope: "own" }]);
  });
});
```

`apps/api/src/modules/teams/teams.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

describe("teams drive team scope", () => {
  it("a team lead's actor includes every member of teams they lead", async () => {
    const admin = await h.signIn(await h.seedUser({ grants: [{ key: "teams.manage", scope: null }] }));
    const lead = await h.seedUser({ grants: [{ key: "leads.view", scope: "team" }] });
    const m1 = await h.seedUser({ grants: [] });
    const m2 = await h.seedUser({ grants: [] });
    const team = (await admin.inject({ method: "POST", url: "/api/v1/teams", payload: { name: "Dubai" } })).json().team;
    const put = await admin.inject({
      method: "PUT",
      url: `/api/v1/teams/${team.id}/members`,
      payload: { members: [{ userId: lead.id, isLead: true }, { userId: m1.id, isLead: false }, { userId: m2.id, isLead: false }] },
    });
    expect(put.statusCode).toBe(200);
    await h.waitForRbacNotify();
    const me = await h.actorOf(lead.id); // harness: loadActor through the app's cache
    expect([...me!.teamMemberIds].sort()).toEqual([lead.id, m1.id, m2.id].sort());
  });
});
```

`apps/api/src/modules/audit/audit.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

describe("GET /audit", () => {
  it("pages newest-first with a cursor and filters by action", async () => {
    for (let i = 0; i < 5; i++) await h.pool.query("INSERT INTO audit_log (action, entity_type) VALUES ('t.page', 't')");
    const c = await h.signIn(await h.seedUser({ grants: [{ key: "audit.view", scope: null }] }));
    const p1 = (await c.inject({ method: "GET", url: "/api/v1/audit?action=t.page&limit=3" })).json();
    expect(p1.entries).toHaveLength(3);
    const p2 = (await c.inject({ method: "GET", url: `/api/v1/audit?action=t.page&limit=3&cursor=${p1.nextCursor}` })).json();
    expect(p2.entries).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();
    expect(p1.entries[0].id).toBeGreaterThan(p2.entries[0].id);
  });

  it("never returns more than 100 per page", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [{ key: "audit.view", scope: null }] }));
    expect((await c.inject({ method: "GET", url: "/api/v1/audit?limit=500" })).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `scripts/dev.sh run pnpm vitest run apps/api/src/modules`
Expected: FAIL (404s). Add `actorOf(userId)` to the harness: build a fresh `loadActor(pool, userId)` call.

- [ ] **Step 3: Implement**

`apps/api/src/modules/users/service.ts`:
```ts
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { revokeUserSessions } from "../../auth/sessions";
import { badRequest, forbidden, notFound } from "../../http/errors";
import { notifyRbac } from "../../rbac/notify";

async function target(req: FastifyRequest, id: string) {
  const [u] = await req.db.select().from(schema.users).where(eq(schema.users.id, id)).for("update");
  if (!u) throw notFound();
  return u;
}
const ownerGuard = (u: { isOwner: boolean }) => {
  if (u.isOwner) throw forbidden("OWNER_PROTECTED", "The owner account can't be changed by anyone else");
};

export async function listUsers(req: FastifyRequest) {
  const users = await req.db.select().from(schema.users).orderBy(schema.users.name);
  const links = await req.db
    .select({ userId: schema.userRoles.userId, id: schema.roles.id, name: schema.roles.name })
    .from(schema.userRoles)
    .innerJoin(schema.roles, and(eq(schema.roles.id, schema.userRoles.roleId), isNull(schema.roles.deletedAt)));
  return {
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      status: u.status,
      isOwner: u.isOwner,
      twoFactor: u.totpEnabled,
      lastLoginAt: u.lastLoginAt,
      roles: links.filter((l) => l.userId === u.id).map(({ id, name }) => ({ id, name })),
    })),
  };
}

export async function updateUser(req: FastifyRequest, id: string, patch: { name?: string; roleIds?: string[] }) {
  const u = await target(req, id);
  if (patch.roleIds) {
    ownerGuard(u);
    const found = patch.roleIds.length
      ? await req.db.select({ id: schema.roles.id }).from(schema.roles).where(and(inArray(schema.roles.id, patch.roleIds), isNull(schema.roles.deletedAt)))
      : [];
    if (found.length !== new Set(patch.roleIds).size) throw badRequest("UNKNOWN_ROLE", "One of those roles doesn't exist");
    await req.db.delete(schema.userRoles).where(eq(schema.userRoles.userId, id));
    if (patch.roleIds.length) await req.db.insert(schema.userRoles).values([...new Set(patch.roleIds)].map((roleId) => ({ userId: id, roleId })));
    await notifyRbac(req.db, id);
  }
  if (patch.name) await req.db.update(schema.users).set({ name: patch.name }).where(eq(schema.users.id, id));
  await audit(req, { action: "user.updated", entityType: "user", entityId: id, diff: { ...(patch.roleIds ? { roleIds: patch.roleIds } : {}), ...(patch.name ? { name: patch.name } : {}) } });
}

export async function setDisabled(req: FastifyRequest, d: AppDeps, id: string, disabled: boolean) {
  const u = await target(req, id);
  ownerGuard(u);
  if (id === req.actor!.userId) throw forbidden("SELF", "You can't disable yourself");
  const now = d.clock();
  await req.db.update(schema.users).set({ status: disabled ? "disabled" : "active", disabledAt: disabled ? now : null }).where(eq(schema.users.id, id));
  if (disabled) await revokeUserSessions(req.db, id, "user_disabled", now);
  await notifyRbac(req.db, id);
  await audit(req, { action: disabled ? "user.disabled" : "user.enabled", entityType: "user", entityId: id });
}

export async function killSessions(req: FastifyRequest, d: AppDeps, id: string) {
  const u = await target(req, id);
  if (u.isOwner && id !== req.actor!.userId) ownerGuard(u);
  const n = await revokeUserSessions(req.db, id, "revoked_by_admin", d.clock());
  await audit(req, { action: "session.revoked_all", entityType: "user", entityId: id, diff: { count: n } });
}
```

`apps/api/src/modules/users/routes.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import * as users from "./service";

const params = z.object({ id: z.uuid() });
const cfg = { permission: "users.manage" as const };

export async function userRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/users", { config: cfg }, (req) => users.listUsers(req));
  r.patch(
    "/api/v1/users/:id",
    { config: cfg, schema: { params, body: z.object({ name: z.string().trim().min(1).max(120).optional(), roleIds: z.array(z.uuid()).max(20).optional() }).strict() } },
    async (req, reply) => {
      await users.updateUser(req, req.params.id, req.body);
      return reply.code(204).send();
    },
  );
  r.post("/api/v1/users/:id/disable", { config: cfg, schema: { params } }, async (req, reply) => {
    await users.setDisabled(req, d, req.params.id, true);
    return reply.code(204).send();
  });
  r.post("/api/v1/users/:id/enable", { config: cfg, schema: { params } }, async (req, reply) => {
    await users.setDisabled(req, d, req.params.id, false);
    return reply.code(204).send();
  });
  r.delete("/api/v1/users/:id/sessions", { config: cfg, schema: { params } }, async (req, reply) => {
    await users.killSessions(req, d, req.params.id);
    return reply.code(204).send();
  });
}
```

`apps/api/src/modules/roles/service.ts`:
```ts
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { PERMISSIONS, isPermissionKey, newId, permissionDef, type Scope } from "@lume/core";
import { schema, type LoginHours } from "@lume/db";
import { audit } from "../../audit/audit";
import { badRequest, conflict, notFound } from "../../http/errors";
import { notifyRbac } from "../../rbac/notify";

export type GrantInput = { key: string; scope?: Scope | null };
export type RoleInput = { name: string; description?: string; color?: string; grants: GrantInput[]; loginHours?: LoginHours | null; ipAllowlist?: string[] | null };

function normaliseGrants(grants: GrantInput[]) {
  const seen = new Map<string, Scope | null>();
  for (const g of grants) {
    if (!isPermissionKey(g.key)) throw badRequest("UNKNOWN_PERMISSION", `Unknown permission ${g.key}`);
    const def = permissionDef(g.key);
    if (!def.scoped && g.scope) throw badRequest("SCOPE_NOT_SUPPORTED", `${g.key} doesn't take a scope`);
    seen.set(g.key, def.scoped ? (g.scope ?? "own") : null);
  }
  return [...seen].map(([key, scope]) => ({ key, scope }));
}

async function getRole(req: FastifyRequest, id: string) {
  const [role] = await req.db.select().from(schema.roles).where(and(eq(schema.roles.id, id), isNull(schema.roles.deletedAt)));
  if (!role) throw notFound();
  const grants = await req.db.select({ key: schema.rolePermissions.permissionKey, scope: schema.rolePermissions.scope }).from(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, id));
  const [{ holders }] = (await req.db.execute(sql`SELECT count(*)::int AS holders FROM user_roles WHERE role_id = ${id}`)).rows as [{ holders: number }];
  return { ...role, grants: grants.sort((a, b) => a.key.localeCompare(b.key)), holders };
}

async function writeGrants(req: FastifyRequest, roleId: string, grants: ReturnType<typeof normaliseGrants>) {
  await req.db.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, roleId));
  if (grants.length) await req.db.insert(schema.rolePermissions).values(grants.map((g) => ({ roleId, permissionKey: g.key, scope: g.scope })));
}

async function assertNameFree(req: FastifyRequest, name: string, exceptId?: string) {
  const [dup] = await req.db.select({ id: schema.roles.id }).from(schema.roles).where(and(eq(schema.roles.name, name), isNull(schema.roles.deletedAt)));
  if (dup && dup.id !== exceptId) throw conflict("ROLE_EXISTS", "A role with that name already exists");
}

export const catalog = () => ({ permissions: PERMISSIONS.map(({ key, group, label, description, scoped }) => ({ key, group, label, description, scoped })) });

export async function listRoles(req: FastifyRequest) {
  const rows = await req.db.select({ id: schema.roles.id }).from(schema.roles).where(isNull(schema.roles.deletedAt)).orderBy(schema.roles.name);
  return { roles: await Promise.all(rows.map((r) => getRole(req, r.id))) };
}

export const readRole = async (req: FastifyRequest, id: string) => ({ role: await getRole(req, id) });

export async function createRole(req: FastifyRequest, input: RoleInput) {
  const grants = normaliseGrants(input.grants);
  await assertNameFree(req, input.name);
  const id = newId();
  await req.db.insert(schema.roles).values({ id, name: input.name, description: input.description ?? "", color: input.color ?? "accent", loginHours: input.loginHours ?? null, ipAllowlist: input.ipAllowlist ?? null, createdBy: req.actor!.userId });
  await writeGrants(req, id, grants);
  await audit(req, { action: "role.created", entityType: "role", entityId: id, diff: { name: input.name, grants } });
  return { role: await getRole(req, id) };
}

export async function updateRole(req: FastifyRequest, id: string, input: Partial<RoleInput>) {
  await getRole(req, id);
  if (input.name) await assertNameFree(req, input.name, id);
  const { grants: rawGrants, ...fields } = input;
  if (Object.keys(fields).length) await req.db.update(schema.roles).set(fields).where(eq(schema.roles.id, id));
  const grants = rawGrants ? normaliseGrants(rawGrants) : undefined;
  if (grants) await writeGrants(req, id, grants);
  await notifyRbac(req.db);
  await audit(req, { action: "role.updated", entityType: "role", entityId: id, diff: { ...fields, ...(grants ? { grants } : {}) } });
  return { role: await getRole(req, id) };
}

export async function deleteRole(req: FastifyRequest, id: string, replacementRoleId?: string) {
  const role = await getRole(req, id);
  if (role.holders > 0) {
    if (!replacementRoleId) throw badRequest("REPLACEMENT_REQUIRED", `${role.holders} people hold this role; choose a replacement`);
    if (replacementRoleId === id) throw badRequest("REPLACEMENT_REQUIRED", "Choose a different role");
    await getRole(req, replacementRoleId);
    // Move holders (skip anyone who already has the replacement), then drop the old links.
    await req.db.execute(sql`INSERT INTO user_roles (user_id, role_id) SELECT user_id, ${replacementRoleId} FROM user_roles WHERE role_id = ${id} ON CONFLICT DO NOTHING`);
    await req.db.delete(schema.userRoles).where(eq(schema.userRoles.roleId, id));
  }
  await req.db.update(schema.roles).set({ deletedAt: new Date() }).where(eq(schema.roles.id, id));
  await notifyRbac(req.db);
  await audit(req, { action: "role.deleted", entityType: "role", entityId: id, diff: { replacementRoleId: replacementRoleId ?? null, holders: role.holders } });
}

export async function cloneRole(req: FastifyRequest, id: string, name: string) {
  const src = await getRole(req, id);
  return createRole(req, { name, description: src.description, color: src.color, grants: src.grants, loginHours: src.loginHours, ipAllowlist: src.ipAllowlist });
}
```

`apps/api/src/modules/roles/routes.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as roles from "./service";

const cfg = { permission: "roles.manage" as const };
const params = z.object({ id: z.uuid() });
const grant = z.object({ key: z.string().regex(/^[a-z_.]+$/), scope: z.enum(["own", "team", "all"]).nullish() });
const loginHours = z.object({ days: z.array(z.number().int().min(0).max(6)).min(1), from: z.string().regex(/^\d\d:\d\d$/), to: z.string().regex(/^\d\d:\d\d$/) });
const role = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(240).optional(),
  color: z.enum(["accent", "ok", "warn", "danger", "meet", "cyan", "neutral"]).optional(),
  grants: z.array(grant).max(100),
  loginHours: loginHours.nullish(),
  ipAllowlist: z.array(z.cidrv4().or(z.cidrv6())).max(50).nullish(),
});

export async function roleRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/permissions", { config: cfg }, async () => roles.catalog());
  r.get("/api/v1/roles", { config: cfg }, (req) => roles.listRoles(req));
  r.get("/api/v1/roles/:id", { config: cfg, schema: { params } }, (req) => roles.readRole(req, req.params.id));
  r.post("/api/v1/roles", { config: cfg, schema: { body: role } }, async (req, reply) => reply.code(201).send(await roles.createRole(req, req.body)));
  r.patch("/api/v1/roles/:id", { config: cfg, schema: { params, body: role.partial() } }, (req) => roles.updateRole(req, req.params.id, req.body));
  r.delete("/api/v1/roles/:id", { config: cfg, schema: { params, body: z.object({ replacementRoleId: z.uuid().optional() }).optional() } }, async (req, reply) => {
    await roles.deleteRole(req, req.params.id, req.body?.replacementRoleId);
    return reply.code(204).send();
  });
  r.post("/api/v1/roles/:id/clone", { config: cfg, schema: { params, body: z.object({ name: z.string().trim().min(1).max(60) }) } }, async (req, reply) =>
    reply.code(201).send(await roles.cloneRole(req, req.params.id, req.body.name)),
  );
}
```

`apps/api/src/modules/teams/service.ts`:
```ts
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { newId } from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { badRequest, conflict, notFound } from "../../http/errors";
import { notifyRbac } from "../../rbac/notify";

async function team(req: FastifyRequest, id: string) {
  const [t] = await req.db.select().from(schema.teams).where(and(eq(schema.teams.id, id), isNull(schema.teams.deletedAt)));
  if (!t) throw notFound();
  return t;
}

export async function listTeams(req: FastifyRequest) {
  const teams = await req.db.select().from(schema.teams).where(isNull(schema.teams.deletedAt)).orderBy(schema.teams.name);
  const members = await req.db.select().from(schema.teamMembers);
  return { teams: teams.map((t) => ({ id: t.id, name: t.name, members: members.filter((m) => m.teamId === t.id).map((m) => ({ userId: m.userId, isLead: m.isLead })) })) };
}

export async function createTeam(req: FastifyRequest, name: string) {
  const [dup] = await req.db.select({ id: schema.teams.id }).from(schema.teams).where(and(eq(schema.teams.name, name), isNull(schema.teams.deletedAt)));
  if (dup) throw conflict("TEAM_EXISTS", "A team with that name already exists");
  const id = newId();
  await req.db.insert(schema.teams).values({ id, name });
  await audit(req, { action: "team.created", entityType: "team", entityId: id, diff: { name } });
  return { team: { id, name, members: [] } };
}

export async function renameTeam(req: FastifyRequest, id: string, name: string) {
  await team(req, id);
  await req.db.update(schema.teams).set({ name }).where(eq(schema.teams.id, id));
  await audit(req, { action: "team.renamed", entityType: "team", entityId: id, diff: { name } });
}

export async function deleteTeam(req: FastifyRequest, id: string) {
  await team(req, id);
  await req.db.delete(schema.teamMembers).where(eq(schema.teamMembers.teamId, id));
  await req.db.update(schema.teams).set({ deletedAt: new Date() }).where(eq(schema.teams.id, id));
  await notifyRbac(req.db);
  await audit(req, { action: "team.deleted", entityType: "team", entityId: id });
}

export async function setMembers(req: FastifyRequest, id: string, members: { userId: string; isLead: boolean }[]) {
  await team(req, id);
  const ids = [...new Set(members.map((m) => m.userId))];
  if (ids.length !== members.length) throw badRequest("DUPLICATE_MEMBER", "Someone is listed twice");
  const found = ids.length ? await req.db.select({ id: schema.users.id }).from(schema.users).where(inArray(schema.users.id, ids)) : [];
  if (found.length !== ids.length) throw badRequest("UNKNOWN_USER", "One of those people doesn't exist");
  await req.db.delete(schema.teamMembers).where(eq(schema.teamMembers.teamId, id));
  if (members.length) await req.db.insert(schema.teamMembers).values(members.map((m) => ({ teamId: id, userId: m.userId, isLead: m.isLead })));
  await notifyRbac(req.db);
  await audit(req, { action: "team.members.set", entityType: "team", entityId: id, diff: { members } });
  return listTeams(req).then((r) => ({ team: r.teams.find((t) => t.id === id) }));
}
```

`apps/api/src/modules/teams/routes.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as teams from "./service";

const cfg = { permission: "teams.manage" as const };
const params = z.object({ id: z.uuid() });
const name = z.object({ name: z.string().trim().min(1).max(60) });

export async function teamRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/teams", { config: cfg }, (req) => teams.listTeams(req));
  r.post("/api/v1/teams", { config: cfg, schema: { body: name } }, async (req, reply) => reply.code(201).send(await teams.createTeam(req, req.body.name)));
  r.patch("/api/v1/teams/:id", { config: cfg, schema: { params, body: name } }, async (req, reply) => {
    await teams.renameTeam(req, req.params.id, req.body.name);
    return reply.code(204).send();
  });
  r.delete("/api/v1/teams/:id", { config: cfg, schema: { params } }, async (req, reply) => {
    await teams.deleteTeam(req, req.params.id);
    return reply.code(204).send();
  });
  r.put(
    "/api/v1/teams/:id/members",
    { config: cfg, schema: { params, body: z.object({ members: z.array(z.object({ userId: z.uuid(), isLead: z.boolean() })).max(200) }) } },
    (req) => teams.setMembers(req, req.params.id, req.body.members),
  );
}
```

`apps/api/src/modules/settings/routes.ts`:
```ts
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { notFound } from "../../http/errors";
import { timezoneSchema } from "../me/routes";

const shape = (s: typeof schema.settings.$inferSelect) => ({
  businessName: s.businessName,
  timezone: s.timezone,
  currency: s.currency,
  defaultCountry: s.defaultCountryIso,
  weekStart: s.weekStart,
  industryPreset: s.industryPreset,
});

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/settings", { config: { permission: "auth.self" } }, async (req) => {
    const [s] = await req.db.select().from(schema.settings);
    if (!s) throw notFound();
    return shape(s);
  });
  r.patch(
    "/api/v1/settings",
    {
      config: { permission: "settings.manage" },
      schema: {
        body: z
          .object({
            businessName: z.string().trim().min(1).max(120),
            timezone: timezoneSchema,
            currency: z.string().regex(/^[A-Z]{3}$/),
            defaultCountry: z.string().regex(/^[A-Z]{2}$/),
            weekStart: z.number().int().min(0).max(6),
          })
          .partial()
          .strict(),
      },
    },
    async (req) => {
      const { defaultCountry, ...rest } = req.body;
      const [s] = await req.db
        .update(schema.settings)
        .set({ ...rest, ...(defaultCountry ? { defaultCountryIso: defaultCountry } : {}) })
        .where(eq(schema.settings.id, 1))
        .returning();
      await audit(req, { action: "settings.updated", entityType: "settings", entityId: "1", diff: req.body });
      return shape(s!);
    },
  );
}
```

`apps/api/src/modules/audit/routes.ts`:
```ts
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { schema } from "@lume/db";

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    "/api/v1/audit",
    {
      config: { permission: "audit.view" },
      schema: {
        querystring: z.object({
          cursor: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          action: z.string().max(80).optional(),
          actorUserId: z.uuid().optional(),
          entityType: z.string().max(40).optional(),
          entityId: z.string().max(80).optional(),
        }),
      },
    },
    async (req) => {
      const q = req.query;
      const where: SQL[] = [];
      if (q.cursor) where.push(lt(schema.auditLog.id, q.cursor));
      if (q.action) where.push(eq(schema.auditLog.action, q.action));
      if (q.actorUserId) where.push(eq(schema.auditLog.actorUserId, q.actorUserId));
      if (q.entityType) where.push(eq(schema.auditLog.entityType, q.entityType));
      if (q.entityId) where.push(eq(schema.auditLog.entityId, q.entityId));
      const rows = await req.db.select().from(schema.auditLog).where(and(...where)).orderBy(desc(schema.auditLog.id)).limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      return { entries: page, nextCursor: rows.length > q.limit ? page.at(-1)!.id : null };
    },
  );
}
```
Register `userRoutes`, `roleRoutes`, `teamRoutes`, `settingsRoutes` and `auditRoutes` in `app.ts`.

- [ ] **Step 4: Run to verify they pass**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/api && pnpm typecheck && pnpm lint'`
Expected: users (3), roles (3), teams (1) and audit (2) pass with the rest.

- [ ] **Step 5: Commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(api): users, roles (replacement on delete, clone), teams, settings and audit log APIs with owner protection

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 13: The route × role access matrix

**Files:**
- Create: `apps/api/test/probes.ts`, `apps/api/test/matrix.test.ts`
- Modify: `apps/api/src/route-guard.ts` (expose the collected route list as `app.lumeRoutes`)

**Interfaces:**
- Consumes: every route registered by `buildApp`, and the harness.
- Produces: `PROBES: Record<"METHOD /path", Probe>`, where `Probe = { path?: (fx) => string; body?: (fx) => unknown; query?: string; expectAllowed?: number[] }`. CI fails when a route has no probe.

- [ ] **Step 1: Expose routes**

In `route-guard.ts`, also record every route (`method`, `url`, `config`) in an array and decorate `app.lumeRoutes` with it (read-only). HEAD duplicates are skipped.

- [ ] **Step 2: Write the matrix**

`apps/api/test/probes.ts`:
```ts
/** One probe per route: how to call it with valid-looking input. Missing probe = failing CI (report §7.5). */
export type Fixtures = { userId: string; roleId: string; teamId: string; inviteToken: string };
export type Probe = { path?: (f: Fixtures) => string; body?: (f: Fixtures) => unknown; query?: string };

const uuid = "0190e0c0-0000-7000-8000-00000000abcd";
export const PROBES: Record<string, Probe> = {
  "GET /api/v1/auth/csrf": {},
  "POST /api/v1/auth/login": { body: () => ({ email: "nobody@test.lume", password: "not-the-password-xx" }) },
  "POST /api/v1/auth/2fa": { body: () => ({ code: "000000" }) },
  "POST /api/v1/auth/recovery": { body: () => ({ code: "AAAAA-BBBBB" }) },
  "POST /api/v1/auth/logout": {},
  "GET /api/v1/auth/me": {},
  "POST /api/v1/auth/password/forgot": { body: () => ({ email: "nobody@test.lume" }) },
  "POST /api/v1/auth/password/reset": { body: () => ({ token: "x".repeat(43), password: "a long and lovely passphrase" }) },
  "GET /api/v1/setup/status": {},
  "POST /api/v1/setup/totp": { body: () => ({ token: "wrong-wrong-wrong-wrong" }) },
  "POST /api/v1/setup": {
    body: () => ({ token: "wrong-wrong-wrong-wrong", business: { name: "X", timezone: "UTC", currency: "AED", defaultCountry: "AE" }, preset: "general", owner: { name: "X", email: "x@x.com", password: "a long and lovely passphrase" }, totp: { secret: "A".repeat(32), code: "000000" } }),
  },
  "GET /api/v1/me/sessions": {},
  "DELETE /api/v1/me/sessions/:id": { path: () => "/api/v1/me/sessions/0000000000000000" },
  "POST /api/v1/me/2fa/enrol": {},
  "POST /api/v1/me/2fa/confirm": { body: () => ({ code: "000000" }) },
  "POST /api/v1/me/2fa/disable": { body: () => ({ password: "wrong" }) },
  "POST /api/v1/me/recovery-codes": { body: () => ({ password: "wrong" }) },
  "PATCH /api/v1/me": { body: () => ({ theme: "obsidian" }) },
  "POST /api/v1/invites": { body: () => ({ email: `new-${Date.now()}@test.lume`, name: "New", roleIds: [] }) },
  "GET /api/v1/invites/:token": { path: (f) => `/api/v1/invites/${f.inviteToken}` },
  "POST /api/v1/invites/:token/accept": { path: () => `/api/v1/invites/${"x".repeat(43)}/accept`, body: () => ({ password: "a long and lovely passphrase" }) },
  "GET /api/v1/users": {},
  "PATCH /api/v1/users/:id": { path: (f) => `/api/v1/users/${f.userId}`, body: () => ({ name: "Renamed" }) },
  "POST /api/v1/users/:id/disable": { path: () => `/api/v1/users/${uuid}/disable` },
  "POST /api/v1/users/:id/enable": { path: () => `/api/v1/users/${uuid}/enable` },
  "DELETE /api/v1/users/:id/sessions": { path: (f) => `/api/v1/users/${f.userId}/sessions` },
  "GET /api/v1/permissions": {},
  "GET /api/v1/roles": {},
  "GET /api/v1/roles/:id": { path: (f) => `/api/v1/roles/${f.roleId}` },
  "POST /api/v1/roles": { body: () => ({ name: `R-${Date.now()}-${Math.random()}`, grants: [] }) },
  "PATCH /api/v1/roles/:id": { path: (f) => `/api/v1/roles/${f.roleId}`, body: () => ({ description: "d" }) },
  "DELETE /api/v1/roles/:id": { path: () => `/api/v1/roles/${uuid}`, body: () => ({}) },
  "POST /api/v1/roles/:id/clone": { path: (f) => `/api/v1/roles/${f.roleId}/clone`, body: () => ({ name: `C-${Date.now()}-${Math.random()}` }) },
  "GET /api/v1/teams": {},
  "POST /api/v1/teams": { body: () => ({ name: `T-${Date.now()}-${Math.random()}` }) },
  "PATCH /api/v1/teams/:id": { path: (f) => `/api/v1/teams/${f.teamId}`, body: () => ({ name: `T2-${Date.now()}-${Math.random()}` }) },
  "DELETE /api/v1/teams/:id": { path: () => `/api/v1/teams/${uuid}` },
  "PUT /api/v1/teams/:id/members": { path: (f) => `/api/v1/teams/${f.teamId}/members`, body: () => ({ members: [] }) },
  "GET /api/v1/settings": {},
  "PATCH /api/v1/settings": { body: () => ({ weekStart: 1 }) },
  "GET /api/v1/audit": { query: "limit=5" },
};
```

`apps/api/test/matrix.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_GRANTS, PERMISSIONS, isPermissionKey, type Grant } from "@lume/core";
import { createHarness, type Harness } from "./harness";
import { PROBES, type Fixtures } from "./probes";

type Who = { name: string; grants: Grant[] | null; owner?: boolean; totp: boolean };
const random = PERMISSIONS.filter((_, i) => i % 3 === 0).map((p) => ({ key: p.key, scope: p.scoped ? "own" : null }) as Grant);
const ACTORS: Who[] = [
  { name: "signed-out", grants: null, totp: false },
  { name: "no-permissions", grants: [], totp: false },
  { name: "sales", grants: [{ key: "leads.view", scope: "own" }, { key: "templates.use", scope: null }], totp: false },
  { name: "random-role", grants: random, totp: true },
  { name: "admin", grants: ALL_GRANTS, totp: true },
  { name: "owner", grants: [], owner: true, totp: true },
];

let h: Harness;
let fx: Fixtures;
const clients = new Map<string, Awaited<ReturnType<Harness["signIn"]>> | null>();
beforeAll(async () => {
  h = await createHarness();
  const target = await h.seedUser({ grants: [] });
  const { rows: [role] } = await h.pool.query("INSERT INTO roles (id, name) VALUES (gen_random_uuid(), 'Matrix role') RETURNING id");
  const teamId = await h.seedTeam(target.id, []);
  fx = { userId: target.id, roleId: role.id, teamId, inviteToken: "y".repeat(43) };
  for (const a of ACTORS) clients.set(a.name, a.grants === null ? null : await h.signIn(await h.seedUser({ grants: a.grants, owner: a.owner, totp: a.totp })));
});
afterAll(async () => h.close());

const routes = () => (h.app as unknown as { lumeRoutes: { method: string; url: string; config: { public?: boolean; permission?: string } }[] }).lumeRoutes.filter((r) => r.url.startsWith("/api/v1/"));

describe("access matrix (report §7.5)", () => {
  it("every /api/v1 route has a probe", () => {
    const missing = routes().map((r) => `${r.method} ${r.url}`).filter((k) => !(k in PROBES));
    expect(missing).toEqual([]);
  });

  it("every route answers each actor as its declaration says", async () => {
    const failures: string[] = [];
    for (const r of routes()) {
      const key = `${r.method} ${r.url}`;
      const p = PROBES[key]!;
      for (const a of ACTORS) {
        const c = clients.get(a.name) ?? null;
        const csrf = c ? null : await h.csrf();
        const url = (p.path ? p.path(fx) : r.url) + (p.query ? `?${p.query}` : "");
        const opts = { method: r.method as "GET", url, ...(p.body ? { payload: p.body(fx) as object } : {}) };
        const res = c ? await c.inject(opts) : await h.app.inject({ ...opts, ...csrf! });
        const perm = r.config.permission;
        const allowed = r.config.public || (a.grants !== null && (a.owner || perm === "auth.self" || (perm && isPermissionKey(perm) && a.grants.some((g) => g.key === perm))));
        const ok = allowed ? res.statusCode !== 401 && res.statusCode !== 403 : a.grants === null ? res.statusCode === 401 : res.statusCode === 403;
        // Public routes may legitimately answer 401/403 for bad input (wrong token, wrong password): accept those.
        const publicBusiness = r.config.public && [400, 401, 403, 404, 429].includes(res.statusCode);
        if (!ok && !publicBusiness) failures.push(`${key} as ${a.name} → ${res.statusCode} (${allowed ? "should be allowed" : "should be denied"})`);
      }
    }
    expect(failures).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/api/test/matrix.test.ts'`
Expected: both tests pass. If "every route has a probe" fails, add the missing probe. If a route answers wrongly, **fix the route's declaration or the plugin**, never the expectation logic.

- [ ] **Step 4: Commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "test(api): route × role access matrix over every /api/v1 route; CI fails on unprobed routes

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 14: Live acceptance on the dev stack

- [ ] **Step 1: Rebuild, migrate, see the setup token**

Run:
```bash
scripts/dev.sh up
scripts/dev.sh logs api | grep "first-run setup token"
```
Expected: the stack is healthy, migrations `0005`–`0007` are applied, and the API log prints the setup token.

- [ ] **Step 2: Scripted end-to-end check through Caddy**

Create `infra/scripts/acceptance-1a.sh` (run on the host). With curl + a cookie jar, and TOTP codes computed inside the toolbox (`node -e` with `@lume/core`'s `totpCode`), it must:
1. `GET /api/v1/setup/status` returns `needsSetup: true`
2. Run setup with the logged token, recording the recovery codes
3. `GET /api/v1/auth/me` as the owner returns 200
4. Invite `riya@nupuur.local` as Sales, then read the invite email from Mailpit's API (`GET http://127.0.0.1:8025/api/v1/messages`) and extract the link
5. Accept the invite, and Riya's `GET /auth/me` returns 200
6. The owner disables Riya, and Riya's next `GET /auth/me` returns 401
7. `GET /api/v1/audit?limit=20` as the owner shows `setup.completed`, `user.invited`, `user.invite.accepted` and `user.disabled`

Each step prints `ok …`, and the script ends `acceptance 1A passed`. Run it with `scripts/dev.sh remote bash infra/scripts/acceptance-1a.sh`.

- [ ] **Step 3: Record and push**

Append a "Phase 1A" section to `docs/runbooks/phase0-acceptance.md` (rename the file to `docs/runbooks/acceptance.md` and update links) with the script output and the CI run URL.
```bash
git add -A && git commit -m "docs: Phase 1A acceptance on the dev stack

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```
Tell the owner that Mailpit is at `http://127.0.0.1:8025` through the tunnel, so they can watch real invite emails arrive.
