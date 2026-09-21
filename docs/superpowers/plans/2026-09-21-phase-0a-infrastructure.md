# Phase 0A — Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A monorepo whose Docker Compose stack (Caddy → web/api, worker, Postgres 17) comes up with HTTPS, passing health checks, versioned migrations and role-separated DB access, plus encrypted backups with an automated restore test, a bootstrap script and CI.

**Architecture:** pnpm monorepo (`apps/api` Fastify, `apps/worker` pg-boss, `apps/web` Next.js placeholder, `packages/config|db|core`). Apps are bundled with esbuild into single files, so runtime images carry no `node_modules`. Everything is built and tested inside containers on the temporary build host `lumedev`, driven from the owner's PC by `scripts/dev.sh`.

**Tech Stack:** Node 22, pnpm 10, TypeScript 5, Fastify 5, pg 8, pg-boss 10, Zod 3, Vitest 3, esbuild, Next.js (current stable), PostgreSQL 17, Caddy 2 (+ caddy-ratelimit), age, rclone, GitHub Actions, GHCR.

**Spec:** `docs/superpowers/specs/2026-09-21-phase-0-foundations-design.md` (read it first), grounded in `docs/LUME_PROJECT_REPORT.md` §4, §12.3–12.7, §15, §17.

## Global Constraints

- The build host `lumedev` is another client's **live** server. Never install/upgrade anything on the host, never touch its nginx, pm2, PostgreSQL 16, UFW or sshd, never run `bootstrap-server.sh` on it. Work only in `/root/lume-dev`. Compose project name is always `lumedev`.
- Every port LUME publishes on `lumedev` binds `127.0.0.1` (Docker publishing bypasses UFW). No container publishes a Postgres port on `lumedev`.
- LUME containers on `lumedev` are capped at ≈1.5 CPU / 3 GB total. Builds run under `nice -n 10`.
- Node 22 LTS, pnpm 10 (via corepack). Never run `pnpm` installs on the PC (it has Node 20). `scripts/dev.sh add …` resolves dependencies with `--lockfile-only` in the toolbox and copies the changed `package.json`/`pnpm-lock.yaml` back to the PC.
- TypeScript strict. Parameterised SQL only. ESLint bans template literals with expressions and string concatenation as `.query()` arguments outside `packages/db`.
- Secrets never enter git. `.env` and key files live in `/root/lume-dev` (mode 600).
- Error shape `{ error: { code, message } }`, never stack traces or SQL (report §4.4).
- Postgres roles: `lume_owner` (schema owner, migrations), `lume_app` (API), `lume_worker` (jobs), `lume_readonly_backup` (pg_dump), `lume_restore` (CREATEDB only). None is superuser or BYPASSRLS.
- Commits end with the trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Map

| Path | Responsibility |
|---|---|
| `scripts/dev.sh` | PC-side dev loop: init remote, sync working tree, run commands in toolbox, compose, tunnel |
| `scripts/test-db.sh` | Start/stop the disposable Postgres 17 used by tests (no published ports on lumedev) |
| `scripts/bundle.mjs` | esbuild bundler for api/worker entrypoints |
| `infra/toolbox/Dockerfile` | Node 22 + pnpm + pg client 17 + age + rclone + shellcheck |
| `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.mjs`, `vitest.config.ts`, `.nvmrc`, `.npmrc`, `.prettierrc.json`, `.prettierignore`, `.dockerignore` | Monorepo tooling |
| `packages/core/src/queues.ts` | Queue names shared by migrate + worker |
| `packages/core/src/ops/retention.ts` | Backup naming + retention selection (pure) |
| `packages/config/src/{schema,load,index}.ts` | Zod env schemas per service, fail-fast loader |
| `packages/db/src/testing.ts` | Per-test-file database creation against the test cluster |
| `packages/db/src/migrate.ts` | SQL migration runner with checksums and advisory lock |
| `packages/db/src/queue-install.ts` | Installs pg-boss schema + queues as `lume_owner` |
| `packages/db/src/cli.ts` | `migrate` command: queue install → migrations |
| `packages/db/migrations/000N_*.sql` | Versioned schema + grants |
| `infra/postgres/init/00-roles.sh` | Creates roles + database on first boot |
| `infra/postgres/postgresql.conf`, `pg_hba.conf`, `pg_hba.test.conf` | Server config (report §15.1), scram-only access |
| `apps/api/src/*` | Fastify server factory, route-declaration guard, health routes, error handler, main |
| `apps/worker/src/*` | pg-boss start/schedules, ops jobs (backup, prune, restore test), exec runner, main, migrate entry |
| `infra/scripts/backup.sh`, `restore-test.sh` | Dump → age → rclone; fetch → decrypt → restore into scratch DB → sanity counts |
| `apps/web/*` | Minimal Next.js app with nonce CSP (0B builds it out) |
| `infra/docker/{api,worker,web,caddy}.Dockerfile` | Images |
| `infra/Caddyfile`, `infra/docker-compose.yml`, `infra/compose.dev.yml`, `infra/.env.example` | Stack |
| `infra/scripts/gen-dev-env.sh`, `infra/scripts/smoke.sh` | Dev env generation, HTTPS/health smoke test |
| `infra/scripts/bootstrap-server.sh` | Idempotent Ubuntu 24.04 hardening with `--dry-run` |
| `.github/workflows/ci.yml` | Lint, typecheck, shellcheck, audit, tests, image build → GHCR |
| `docs/runbooks/restore.md`, `docs/runbooks/phase0-acceptance.md` | Recovery runbook (RPO/RTO) and recorded acceptance evidence |

---

### Task 1: Dev loop and toolbox

**Files:**
- Create: `scripts/dev.sh`, `infra/toolbox/Dockerfile`

**Interfaces:**
- Produces: `scripts/dev.sh <init|sync|toolbox|run <cmd...>|add <pnpm add args>|test-db <up|down>|up|down|ps|logs [svc]|compose <args>|remote <cmd>|fetch <path>|tunnel>`. `run` executes inside `lumedev-toolbox:latest` on the server with the repo at `/repo`, joined to the Docker network `lumedev_test`, with `/root/lume-dev/test.env` as env file.

- [ ] **Step 1: Write the toolbox Dockerfile**

`infra/toolbox/Dockerfile`:
```dockerfile
# Build/test toolbox for LUME. Runs on the build host; nothing is installed on the host itself.
FROM node:22-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg age rclone shellcheck \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 \
 && rm -rf /var/lib/apt/lists/*
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /repo
```

- [ ] **Step 2: Write `scripts/dev.sh`**

```bash
#!/usr/bin/env bash
# LUME dev loop. Edit on this PC; everything runs in containers on the build host.
# The build host is someone else's live server: see docs/superpowers/specs/2026-09-21-phase-0-foundations-design.md §2.
set -euo pipefail

HOST="${LUME_DEV_HOST:-lumedev}"
REMOTE_ROOT=/root/lume-dev
REMOTE_SRC="$REMOTE_ROOT/src"
PROJECT=lumedev
TOOLBOX=lumedev-toolbox:latest
TEST_NET=lumedev_test

cd "$(cd "$(dirname "$0")/.." && pwd)"

remote() { ssh -o BatchMode=yes "$HOST" "$@"; }

# A commit object holding the working tree (tracked + untracked, honouring .gitignore)
# without touching the real index or HEAD.
snapshot_commit() {
  local idx tree
  idx="$(mktemp)"
  # Start from the real index so file modes set with `git update-index --chmod=+x` survive
  # (Windows checkouts have core.fileMode=false, so `git add` alone would drop the executable bit).
  cp "$(git rev-parse --git-path index)" "$idx"
  GIT_INDEX_FILE="$idx" git add -A
  tree="$(GIT_INDEX_FILE="$idx" git write-tree)"
  rm -f "$idx"
  git commit-tree "$tree" -p HEAD -m "dev snapshot"
}

cmd_init() {
  remote "set -e
    mkdir -p $REMOTE_ROOT/secrets && chmod 700 $REMOTE_ROOT $REMOTE_ROOT/secrets
    [ -d $REMOTE_ROOT/repo.git ] || git init -q --bare $REMOTE_ROOT/repo.git
    [ -d $REMOTE_SRC/.git ] || git clone -q $REMOTE_ROOT/repo.git $REMOTE_SRC
    touch $REMOTE_ROOT/test.env && chmod 600 $REMOTE_ROOT/test.env
    docker network inspect $TEST_NET >/dev/null 2>&1 || docker network create --subnet 172.31.0.0/24 $TEST_NET >/dev/null"
  git remote get-url lumedev >/dev/null 2>&1 || git remote add lumedev "$HOST:$REMOTE_ROOT/repo.git"
  echo "remote ready: $HOST:$REMOTE_SRC"
}

cmd_sync() {
  local c
  c="$(snapshot_commit)"
  git push -q -f lumedev "$c:refs/heads/dev"
  remote "cd $REMOTE_SRC && git fetch -q origin dev && git reset -q --hard FETCH_HEAD && git clean -qfd"
}

cmd_toolbox() {
  cmd_sync
  remote "cd $REMOTE_SRC && nice -n 10 docker build -q -t $TOOLBOX infra/toolbox"
}

cmd_run() {
  [ $# -gt 0 ] || { echo "usage: dev.sh run <command...>" >&2; exit 2; }
  cmd_sync
  local q
  q="$(printf '%q ' "$@")"
  remote "cd $REMOTE_SRC && nice -n 10 docker run --rm -i --init --cpus 1.5 --memory 3g \
    --network $TEST_NET --env-file $REMOTE_ROOT/test.env -e CI=1 -e npm_config_store_dir=/pnpm-store \
    -v $REMOTE_SRC:/repo -v lumedev_pnpm_store:/pnpm-store -w /repo \
    $TOOLBOX bash -lc $(printf '%q' "$q")"
}

# Dependency changes happen on the PC, lockfile only (no node_modules here).
cmd_add() { corepack pnpm@10 add --lockfile-only "$@"; }

compose() {
  local q
  q="$(printf '%q ' "$@")"
  remote "cd $REMOTE_SRC && docker compose -p $PROJECT --env-file $REMOTE_ROOT/.env \
    -f infra/docker-compose.yml -f infra/compose.dev.yml $q"
}

cmd_up() {
  cmd_sync
  remote "cd $REMOTE_SRC && LUME_DEV_ROOT=$REMOTE_ROOT bash infra/scripts/gen-dev-env.sh"
  remote "cd $REMOTE_SRC && nice -n 10 docker compose -p $PROJECT --env-file $REMOTE_ROOT/.env \
    -f infra/docker-compose.yml -f infra/compose.dev.yml build"
  compose up -d db
  compose run --rm migrate
  compose up -d
}

case "${1:-}" in
  init) cmd_init ;;
  sync) cmd_sync ;;
  toolbox) cmd_toolbox ;;
  run) shift; cmd_run "$@" ;;
  add) shift; cmd_add "$@" ;;
  test-db) shift; cmd_sync; remote "cd $REMOTE_SRC && LUME_DEV_ROOT=$REMOTE_ROOT bash scripts/test-db.sh ${1:-up}" ;;
  up) cmd_up ;;
  down) compose down ;;
  ps) compose ps ;;
  logs) shift; compose logs --tail=200 "$@" ;;
  compose) shift; compose "$@" ;;
  remote) shift; remote "cd $REMOTE_SRC && $*" ;;
  fetch) shift; for p in "$@"; do scp -q "$HOST:$REMOTE_SRC/$p" "$p"; done ;;
  tunnel) echo "https://lume.localhost:8443 → $HOST (Ctrl+C to stop)"; ssh -N -L 8443:127.0.0.1:8443 "$HOST" ;;
  *) echo "usage: dev.sh {init|sync|toolbox|run|add|test-db|up|down|ps|logs|compose|remote|fetch|tunnel}" >&2; exit 2 ;;
esac
```

- [ ] **Step 3: Run it to verify the loop works end to end**

Run:
```bash
chmod +x scripts/dev.sh
scripts/dev.sh init
scripts/dev.sh toolbox
scripts/dev.sh run bash -c 'node --version; pnpm --version; pg_dump --version; age --version; rclone version | head -1'
scripts/dev.sh run shellcheck scripts/dev.sh
```
Expected: `remote ready: lumedev:/root/lume-dev/src`, then `v22.*`, `10.*`, `pg_dump (PostgreSQL) 17.*`, an age version, `rclone v1.*`. shellcheck prints nothing (exit 0).

- [ ] **Step 4: Commit**

```bash
git add scripts/dev.sh infra/toolbox/Dockerfile
git commit -m "chore: dev loop running all tooling in containers on the build host

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Monorepo tooling

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `.nvmrc`, `.npmrc`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc.json`, `.prettierignore`, `vitest.config.ts`, `.dockerignore`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/src/queues.ts`
- Test: `packages/core/src/queues.test.ts`

**Interfaces:**
- Produces: `@lume/core` exporting `QUEUE_NAMES: readonly ["ops.backup","ops.restore-test"]` and `type QueueName`. Root scripts `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

- [ ] **Step 1: Write the root files**

`package.json`:
```json
{
  "name": "lume",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.34.5",
  "engines": { "node": ">=22 <23", "pnpm": ">=10" },
  "scripts": {
    "lint": "eslint . && prettier --check .",
    "format": "prettier --write .",
    "typecheck": "pnpm -r --parallel typecheck",
    "test": "vitest run",
    "build": "pnpm -r build"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"

# Packages allowed to run install scripts (pnpm 10 blocks all others).
onlyBuiltDependencies:
  - esbuild
```

`packageManager` pins pnpm for corepack everywhere. Unpinned, Docker images fetch the newest pnpm (12.x), which refuses esbuild's install script.

`.nvmrc`: `22`

`.npmrc`:
```
engine-strict=true
auto-install-peers=true
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "types": ["node"]
  }
}
```

`eslint.config.mjs`:
```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

const noBuiltSql = [
  "error",
  {
    selector: "CallExpression[callee.property.name='query'] > TemplateLiteral[expressions.length>0]",
    message: "Build SQL with parameters ($1, $2…), never template literals (report §12.3).",
  },
  {
    selector: "CallExpression[callee.property.name='query'] > BinaryExpression",
    message: "Build SQL with parameters ($1, $2…), never string concatenation (report §12.3).",
  },
];

export default tseslint.config(
  { ignores: ["**/dist/**", "**/.next/**", "**/node_modules/**", "coverage/**", "docs/design/prototypes/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node } } },
  { files: ["**/*.{ts,tsx,js,mjs}"], rules: { "no-restricted-syntax": noBuiltSql } },
  // The migrations package is the one place allowed to run identifier-built SQL (report §12.3).
  { files: ["packages/db/**"], rules: { "no-restricted-syntax": "off" } },
);
```

`.prettierrc.json`:
```json
{ "printWidth": 110, "singleQuote": false, "trailingComma": "all" }
```

`.prettierignore`:
```
pnpm-lock.yaml
docs/
**/dist/
**/.next/
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
```

`.dockerignore`:
```
**/node_modules
**/.next
**/dist
.git
docs
.superpowers
```

- [ ] **Step 2: Add root dev dependencies (lockfile only, on the PC)**

Run:
```bash
scripts/dev.sh add -w -D typescript@^5 vitest@^3 eslint@^9 @eslint/js@^9 typescript-eslint@^8 globals prettier@^3 @types/node@^22 esbuild
```
Expected: `package.json` gains `devDependencies`, `pnpm-lock.yaml` is created, no `node_modules` on the PC.

- [ ] **Step 3: Write the `@lume/core` package with a failing test**

`packages/core/package.json`:
```json
{
  "name": "@lume/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc -p tsconfig.json" }
}
```

`packages/core/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`packages/core/src/queues.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "./queues";

describe("QUEUE_NAMES", () => {
  it("lists the Phase 0 ops queues exactly once each", () => {
    expect(QUEUE_NAMES).toEqual(["ops.backup", "ops.restore-test"]);
    expect(new Set(QUEUE_NAMES).size).toBe(QUEUE_NAMES.length);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile && pnpm test'`
Expected: FAIL, `Failed to resolve import "./queues"`.

- [ ] **Step 5: Implement**

`packages/core/src/queues.ts`:
```ts
/** Every pg-boss queue LUME uses. The migrate step creates these as lume_owner (pg-boss partitions need the table owner). */
export const QUEUE_NAMES = ["ops.backup", "ops.restore-test"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];
```

`packages/core/src/index.ts`:
```ts
export * from "./queues";
```

- [ ] **Step 6: Run the whole toolchain to verify it passes**

Run: `scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test'`
Expected: lint clean, typecheck clean, `1 passed`.

If prettier reports files, run `scripts/dev.sh run pnpm format`, then `scripts/dev.sh fetch <each reported path>` to bring the formatted files back to the PC.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml .nvmrc .npmrc tsconfig.base.json eslint.config.mjs .prettierrc.json .prettierignore vitest.config.ts .dockerignore packages/core
git commit -m "chore: pnpm monorepo with strict TypeScript, ESLint SQL rule, Vitest projects

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `@lume/config` — fail-fast env validation

**Files:**
- Create: `packages/config/package.json`, `packages/config/tsconfig.json`, `packages/config/src/schema.ts`, `packages/config/src/load.ts`, `packages/config/src/index.ts`
- Test: `packages/config/src/config.test.ts`

**Interfaces:**
- Produces:
  - `apiSchema`, `workerSchema`, `migrateSchema` (Zod objects)
  - `loadConfig<S extends z.ZodTypeAny>(schema: S, env?: Record<string, string | undefined>): z.infer<S>`, which throws `ConfigError` with `issues: string[]`
  - `isWeakSecret(s: string): boolean`
  - `type ApiConfig`, `type WorkerConfig`, `type MigrateConfig`
- Key fields: `DATABASE_URL_APP` (user `lume_app`), `DATABASE_URL_WORKER` (`lume_worker`), `DATABASE_URL_BACKUP` (`lume_readonly_backup`), `DATABASE_URL_RESTORE` (`lume_restore`), `DATABASE_URL_OWNER` (`lume_owner`), `LUME_MASTER_KEY` (base64, ≥32 bytes), `LUME_PUBLIC_HOST`, `API_PORT` (default 3001), `BACKUP_AGE_RECIPIENTS: string[]` (≥2), `BACKUP_AGE_IDENTITY_FILE`, `RCLONE_REMOTE`, `OPS_SCRIPTS_DIR`, `MIGRATIONS_DIR`, `LOG_LEVEL`, `NODE_ENV`.

- [ ] **Step 1: Package files and dependency**

`packages/config/package.json`:
```json
{
  "name": "@lume/config",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc -p tsconfig.json" }
}
```
`packages/config/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```
Run: `scripts/dev.sh add --filter @lume/config zod@^3.25`

- [ ] **Step 2: Write the failing tests**

`packages/config/src/config.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ConfigError, apiSchema, isWeakSecret, loadConfig, migrateSchema, workerSchema } from "./index";

const PW = "k3yP4ssw0rdL0ngEnough9";
const KEY = Buffer.alloc(32, 7).toString("base64");
const AGE_A = "age1" + "q".repeat(58);
const AGE_B = "age1" + "p".repeat(58);
const url = (role: string, pw = PW) => `postgres://${role}:${pw}@db:5432/lume`;

const apiEnv = {
  LUME_PUBLIC_HOST: "lume.localhost",
  LUME_MASTER_KEY: KEY,
  DATABASE_URL_APP: url("lume_app"),
};
const workerEnv = {
  LUME_MASTER_KEY: KEY,
  DATABASE_URL_WORKER: url("lume_worker"),
  DATABASE_URL_BACKUP: url("lume_readonly_backup"),
  DATABASE_URL_RESTORE: url("lume_restore"),
  BACKUP_AGE_RECIPIENTS: `${AGE_A}, ${AGE_B}`,
  BACKUP_AGE_IDENTITY_FILE: "/run/secrets/restore_agekey",
};

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  throw new Error("expected ConfigError");
}

describe("loadConfig", () => {
  it("accepts a valid api env and applies defaults", () => {
    const c = loadConfig(apiSchema, apiEnv);
    expect(c.API_PORT).toBe(3001);
    expect(c.NODE_ENV).toBe("production");
  });

  it("reports every missing variable at once", () => {
    const issues = issuesOf(() => loadConfig(apiSchema, {}));
    expect(issues.length).toBeGreaterThanOrEqual(3);
    expect(issues.join("\n")).toMatch(/DATABASE_URL_APP/);
    expect(issues.join("\n")).toMatch(/LUME_MASTER_KEY/);
    expect(issues.join("\n")).toMatch(/LUME_PUBLIC_HOST/);
  });

  it("rejects a master key shorter than 32 bytes", () => {
    const issues = issuesOf(() =>
      loadConfig(apiSchema, { ...apiEnv, LUME_MASTER_KEY: Buffer.alloc(16, 1).toString("base64") }),
    );
    expect(issues.join()).toMatch(/LUME_MASTER_KEY/);
  });

  it("rejects weak database passwords and the wrong role", () => {
    expect(issuesOf(() => loadConfig(apiSchema, { ...apiEnv, DATABASE_URL_APP: url("lume_app", "postgres") })).join()).toMatch(/too weak/);
    expect(issuesOf(() => loadConfig(apiSchema, { ...apiEnv, DATABASE_URL_APP: url("lume_owner") })).join()).toMatch(/lume_app/);
  });

  it("never echoes secret values in errors", () => {
    const err = issuesOf(() => loadConfig(apiSchema, { ...apiEnv, DATABASE_URL_APP: url("lume_owner"), LUME_MASTER_KEY: "c2hvcnQ=" })).join();
    expect(err).not.toContain(PW);
    expect(err).not.toContain("c2hvcnQ=");
  });

  it("parses worker recipients and requires two keys", () => {
    expect(loadConfig(workerSchema, workerEnv).BACKUP_AGE_RECIPIENTS).toEqual([AGE_A, AGE_B]);
    expect(issuesOf(() => loadConfig(workerSchema, { ...workerEnv, BACKUP_AGE_RECIPIENTS: AGE_A })).join()).toMatch(/offline key and the restore-test key/);
  });

  it("validates the migrate env", () => {
    expect(loadConfig(migrateSchema, { DATABASE_URL_OWNER: url("lume_owner") }).MIGRATIONS_DIR).toBe("/app/migrations");
  });
});

describe("isWeakSecret", () => {
  it("flags short, common and repeated secrets", () => {
    expect(isWeakSecret("short")).toBe(true);
    expect(isWeakSecret("changeme")).toBe(true);
    expect(isWeakSecret("aaaaaaaaaaaaaaaaaaaa")).toBe(true);
    expect(isWeakSecret(PW)).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile && pnpm vitest run packages/config'`
Expected: FAIL, cannot resolve `./index`.

- [ ] **Step 4: Implement**

`packages/config/src/schema.ts`:
```ts
import { z } from "zod";

const COMMON = new Set(["postgres", "password", "changeme", "lume", "secret", "admin", "root", "12345678"]);

/** Too short, a well-known default, or one repeated character. */
export function isWeakSecret(s: string): boolean {
  return s.length < 16 || COMMON.has(s.toLowerCase()) || /^(.)\1+$/.test(s);
}

const pgUrl = (role: string) =>
  z.string().superRefine((value, ctx) => {
    let u: URL;
    try {
      u = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "must be a postgres:// URL" });
      return;
    }
    if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
      ctx.addIssue({ code: "custom", message: "must be a postgres:// URL" });
    }
    if (decodeURIComponent(u.username) !== role) {
      ctx.addIssue({ code: "custom", message: `must connect as ${role}` });
    }
    if (isWeakSecret(decodeURIComponent(u.password))) {
      ctx.addIssue({ code: "custom", message: "password is missing or too weak (min 16 chars)" });
    }
  });

const masterKey = z
  .string()
  .refine(
    (v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, "base64").length >= 32,
    "must be base64 of at least 32 random bytes",
  );

const AGE_PUBLIC_KEY = /^age1[02-9ac-hj-np-z]{58}$/;

const base = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export const apiSchema = base.extend({
  LUME_PUBLIC_HOST: z.string().min(1),
  LUME_MASTER_KEY: masterKey,
  DATABASE_URL_APP: pgUrl("lume_app"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  SMTP_URL: z.string().url().optional(),
});

export const workerSchema = base.extend({
  LUME_MASTER_KEY: masterKey,
  DATABASE_URL_WORKER: pgUrl("lume_worker"),
  DATABASE_URL_BACKUP: pgUrl("lume_readonly_backup"),
  DATABASE_URL_RESTORE: pgUrl("lume_restore"),
  BACKUP_AGE_RECIPIENTS: z
    .string()
    .transform((s) => s.split(",").map((k) => k.trim()).filter(Boolean))
    .pipe(
      z
        .array(z.string().regex(AGE_PUBLIC_KEY, "must be an age public key (age1…)"))
        .min(2, "needs the offline key and the restore-test key"),
    ),
  BACKUP_AGE_IDENTITY_FILE: z.string().min(1),
  RCLONE_REMOTE: z.string().min(1).default("offsite:/var/lib/lume/offsite"),
  OPS_SCRIPTS_DIR: z.string().min(1).default("/app/scripts"),
});

export const migrateSchema = base.extend({
  DATABASE_URL_OWNER: pgUrl("lume_owner"),
  MIGRATIONS_DIR: z.string().min(1).default("/app/migrations"),
});

export type ApiConfig = z.infer<typeof apiSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;
export type MigrateConfig = z.infer<typeof migrateSchema>;
```

`packages/config/src/load.ts`:
```ts
import type { z } from "zod";

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/** Parse env against a schema; throw one error listing every problem (never the secret values). */
export function loadConfig<S extends z.ZodTypeAny>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  return result.data;
}
```

`packages/config/src/index.ts`:
```ts
export * from "./schema";
export * from "./load";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile && pnpm vitest run packages/config && pnpm typecheck'`
Expected: all tests in `config.test.ts` pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/config pnpm-lock.yaml
git commit -m "feat(config): per-service env schemas that fail fast and reject weak secrets

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Postgres cluster — roles, config, test database

**Files:**
- Create: `infra/postgres/init/00-roles.sh`, `infra/postgres/postgresql.conf`, `infra/postgres/pg_hba.conf`, `infra/postgres/pg_hba.test.conf`, `scripts/test-db.sh`
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/src/testing.ts`, `packages/db/src/index.ts`
- Test: `packages/db/src/roles.test.ts`

**Interfaces:**
- Produces:
  - `scripts/test-db.sh up|down`. It writes `$LUME_DEV_ROOT/test.env` with `TEST_DATABASE_URL` (superuser, db `postgres`) and `TEST_PW_LUME_OWNER`, `TEST_PW_LUME_APP`, `TEST_PW_LUME_WORKER`, `TEST_PW_LUME_READONLY_BACKUP`, `TEST_PW_LUME_RESTORE`. With `TEST_DB_PUBLISH=<port>` (CI only) it publishes `127.0.0.1:<port>`, and the URL host becomes `127.0.0.1:<port>`.
  - `@lume/db`: `createTestDatabase(): Promise<TestDatabase>` where `TestDatabase = { name: string; url(role?: DbRole): string; drop(): Promise<void> }`, `roleUrl(role: DbRole, database: string): string`, `type DbRole = "lume_owner" | "lume_app" | "lume_worker" | "lume_readonly_backup" | "lume_restore"`.

- [ ] **Step 1: Write the role bootstrap and server config**

`infra/postgres/init/00-roles.sh`:
```bash
#!/usr/bin/env bash
# First boot only (docker-entrypoint-initdb.d), run by the image's bootstrap superuser.
# Creates LUME's roles (report §12.4) and the database. Grants live in versioned migrations.
set -euo pipefail
: "${LUME_DB_NAME:=lume}"
for v in LUME_OWNER_PASSWORD LUME_APP_PASSWORD LUME_WORKER_PASSWORD LUME_BACKUP_PASSWORD LUME_RESTORE_PASSWORD; do
  [ -n "${!v:-}" ] || { echo "00-roles.sh: $v is required" >&2; exit 1; }
done

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_pw="$LUME_OWNER_PASSWORD" -v app_pw="$LUME_APP_PASSWORD" -v worker_pw="$LUME_WORKER_PASSWORD" \
  -v backup_pw="$LUME_BACKUP_PASSWORD" -v restore_pw="$LUME_RESTORE_PASSWORD" -v dbname="$LUME_DB_NAME" <<'SQL'
SET password_encryption = 'scram-sha-256';
CREATE ROLE lume_owner           LOGIN PASSWORD :'owner_pw'   NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE ROLE lume_app             LOGIN PASSWORD :'app_pw'     NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE ROLE lume_worker          LOGIN PASSWORD :'worker_pw'  NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE ROLE lume_readonly_backup LOGIN PASSWORD :'backup_pw'  NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE ROLE lume_restore         LOGIN PASSWORD :'restore_pw' NOSUPERUSER NOCREATEROLE CREATEDB   NOBYPASSRLS;
CREATE DATABASE :"dbname" OWNER lume_owner;
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO lume_app, lume_worker, lume_readonly_backup;
SQL
```

`infra/postgres/postgresql.conf` (report §15.1, for the KVM 2):
```
listen_addresses = '*'
max_connections = 50
password_encryption = scram-sha-256
shared_buffers = 2GB
effective_cache_size = 5GB
work_mem = 16MB
maintenance_work_mem = 256MB
wal_compression = on
random_page_cost = 1.1
timezone = 'UTC'
log_timezone = 'UTC'
log_min_duration_statement = 500
log_connections = on
log_disconnections = on
log_line_prefix = '%m [%p] %u@%d '
```

`infra/postgres/pg_hba.conf` (app subnet only, report §12.4):
```
# TYPE  DATABASE  USER  ADDRESS          METHOD
local   all       all                    peer
host    all       all   127.0.0.1/32     scram-sha-256
host    all       all   172.30.0.0/24    scram-sha-256
```

`infra/postgres/pg_hba.test.conf` (test network only):
```
local   all       all                    peer
host    all       all   127.0.0.1/32     scram-sha-256
host    all       all   172.31.0.0/24    scram-sha-256
host    all       all   172.17.0.0/16    scram-sha-256
```
(`172.17.0.0/16` is Docker's default bridge, used on CI where the port is published to `127.0.0.1`.)

- [ ] **Step 2: Write `scripts/test-db.sh`**

```bash
#!/usr/bin/env bash
# Disposable Postgres 17 for integration tests. On lumedev it publishes NO port and is reachable only
# from the lumedev_test network. CI sets TEST_DB_PUBLISH to reach it on 127.0.0.1.
set -euo pipefail
NAME=lumedev-pgtest
NET=lumedev_test
ROOT="${LUME_DEV_ROOT:-/root/lume-dev}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"

up() {
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create --subnet 172.31.0.0/24 "$NET" >/dev/null
  if [ -n "$(docker ps -q -f "name=^${NAME}$")" ]; then echo "$NAME already running"; return; fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  local su owner app worker backup restore publish=() host="$NAME:5432"
  su="$(openssl rand -hex 24)"; owner="$(openssl rand -hex 24)"; app="$(openssl rand -hex 24)"
  worker="$(openssl rand -hex 24)"; backup="$(openssl rand -hex 24)"; restore="$(openssl rand -hex 24)"
  if [ -n "${TEST_DB_PUBLISH:-}" ]; then publish=(-p "127.0.0.1:${TEST_DB_PUBLISH}:5432"); host="127.0.0.1:${TEST_DB_PUBLISH}"; fi
  docker run -d --name "$NAME" --network "$NET" "${publish[@]}" --cpus 1 --memory 1g \
    --tmpfs /var/lib/postgresql/data:rw,size=1g \
    -e POSTGRES_PASSWORD="$su" -e LUME_OWNER_PASSWORD="$owner" -e LUME_APP_PASSWORD="$app" \
    -e LUME_WORKER_PASSWORD="$worker" -e LUME_BACKUP_PASSWORD="$backup" -e LUME_RESTORE_PASSWORD="$restore" \
    -v "$SRC/infra/postgres/init:/docker-entrypoint-initdb.d:ro" \
    -v "$SRC/infra/postgres/pg_hba.test.conf:/etc/postgresql/pg_hba.conf:ro" \
    postgres:17 -c hba_file=/etc/postgresql/pg_hba.conf -c fsync=off -c shared_buffers=128MB -c max_connections=200 >/dev/null
  for _ in $(seq 1 60); do
    if docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U postgres; then break; fi
    sleep 1
  done
  docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U postgres || { docker logs "$NAME" | tail -40; exit 1; }
  umask 077
  cat > "$ROOT/test.env" <<EOF
TEST_DATABASE_URL=postgres://postgres:${su}@${host}/postgres
TEST_PW_LUME_OWNER=${owner}
TEST_PW_LUME_APP=${app}
TEST_PW_LUME_WORKER=${worker}
TEST_PW_LUME_READONLY_BACKUP=${backup}
TEST_PW_LUME_RESTORE=${restore}
EOF
  echo "$NAME ready"
}

down() { docker rm -f "$NAME" >/dev/null 2>&1 || true; : > "$ROOT/test.env"; echo "$NAME removed"; }

case "${1:-up}" in up) up ;; down) down ;; *) echo "usage: test-db.sh up|down" >&2; exit 2 ;; esac
```

- [ ] **Step 3: Write the `@lume/db` testing helper and a failing role test**

`packages/db/package.json`:
```json
{
  "name": "@lume/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc -p tsconfig.json" }
}
```
`packages/db/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```
Run: `scripts/dev.sh add --filter @lume/db pg@^8 && scripts/dev.sh add --filter @lume/db -D @types/pg@^8`

`packages/db/src/roles.test.ts`:
```ts
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminUrl, createTestDatabase, type TestDatabase } from "./testing";

describe("postgres roles (report §12.4)", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  it("no LUME role is superuser or bypasses RLS; only lume_restore may create databases", async () => {
    const c = new pg.Client({ connectionString: adminUrl() });
    await c.connect();
    const { rows } = await c.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; scram: boolean }>(
      `SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreatedb, a.rolpassword LIKE 'SCRAM-SHA-256$%' AS scram
         FROM pg_roles r JOIN pg_authid a ON a.oid = r.oid
        WHERE r.rolname LIKE 'lume\\_%' ORDER BY r.rolname`,
    );
    await c.end();
    expect(rows.map((r) => r.rolname)).toEqual(["lume_app", "lume_owner", "lume_readonly_backup", "lume_restore", "lume_worker"]);
    for (const r of rows) {
      expect(r.rolsuper, r.rolname).toBe(false);
      expect(r.rolbypassrls, r.rolname).toBe(false);
      expect(r.rolcreatedb, r.rolname).toBe(r.rolname === "lume_restore");
      expect(r.scram, r.rolname).toBe(true);
    }
  });

  it("every role can connect to a LUME database with its own password", async () => {
    for (const role of ["lume_owner", "lume_app", "lume_worker", "lume_readonly_backup"] as const) {
      const c = new pg.Client({ connectionString: db.url(role) });
      await c.connect();
      const { rows } = await c.query<{ u: string }>("SELECT current_user AS u");
      await c.end();
      expect(rows[0]?.u).toBe(role);
    }
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `scripts/dev.sh test-db up && scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile && pnpm vitest run packages/db'`
Expected: `lumedev-pgtest ready`, then FAIL: cannot resolve `./testing`.

- [ ] **Step 5: Implement the helper**

`packages/db/src/testing.ts`:
```ts
import { randomBytes } from "node:crypto";
import pg from "pg";

export type DbRole = "lume_owner" | "lume_app" | "lume_worker" | "lume_readonly_backup" | "lume_restore";

export type TestDatabase = {
  name: string;
  /** Connection URL for this database as the given role (default lume_owner). */
  url(role?: DbRole): string;
  drop(): Promise<void>;
};

export function adminUrl(): string {
  const u = process.env.TEST_DATABASE_URL;
  if (!u) throw new Error("TEST_DATABASE_URL is not set. Run `scripts/dev.sh test-db up` first.");
  return u;
}

export function roleUrl(role: DbRole, database: string): string {
  const u = new URL(adminUrl());
  const pw = process.env[`TEST_PW_${role.toUpperCase()}`];
  if (!pw) throw new Error(`TEST_PW_${role.toUpperCase()} is not set`);
  u.username = role;
  u.password = pw;
  u.pathname = `/${database}`;
  return u.toString();
}

async function asAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: adminUrl() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** A fresh database owned by lume_owner, set up like the production one (see 00-roles.sh). */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `t_${randomBytes(6).toString("hex")}`;
  await asAdmin(async (c) => {
    await c.query(`CREATE DATABASE ${name} OWNER lume_owner`);
    await c.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await c.query(`GRANT CONNECT ON DATABASE ${name} TO lume_app, lume_worker, lume_readonly_backup`);
  });
  return {
    name,
    url: (role: DbRole = "lume_owner") => roleUrl(role, name),
    drop: () => asAdmin(async (c) => void (await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`))),
  };
}
```

`packages/db/src/index.ts`:
```ts
export * from "./testing";
```

- [ ] **Step 6: Run the tests to verify they pass, and lint the shell scripts**

Run: `scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile && pnpm vitest run packages/db && shellcheck scripts/*.sh infra/postgres/init/*.sh'`
Expected: 2 tests pass, shellcheck silent.

- [ ] **Step 7: Commit**

```bash
git add infra/postgres scripts/test-db.sh packages/db pnpm-lock.yaml
git commit -m "feat(db): least-privilege Postgres roles, scram-only hba, isolated test cluster

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Migration runner, Phase 0 migrations, queue schema

**Files:**
- Create: `packages/db/src/migrate.ts`, `packages/db/src/queue-install.ts`, `packages/db/src/cli.ts`
- Create: `packages/db/migrations/0001_extensions.sql`, `0002_grants.sql`, `0003_ops_restore_tests.sql`, `0004_queue_grants.sql`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/src/migrate.test.ts`, `packages/db/src/schema.test.ts`

**Interfaces:**
- Consumes: `createTestDatabase`, `QUEUE_NAMES` (`@lume/core`), `migrateSchema`/`loadConfig` (`@lume/config`).
- Produces:
  - `migrate(connectionString: string, dir: string): Promise<{ applied: string[]; skipped: string[] }>`, throws `MigrationError`
  - `listMigrations(dir): Promise<{ name; sql; checksum }[]>`
  - `installQueueSchema(ownerUrl: string, queues: readonly string[]): Promise<void>`
  - `runMigrateCommand(env?): Promise<void>`
  - `MIGRATIONS_DIR_DEFAULT` (absolute path of `packages/db/migrations`, for tests)

- [ ] **Step 1: Write failing runner tests**

`packages/db/src/migrate.test.ts`:
```ts
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MigrationError, migrate } from "./migrate";
import { createTestDatabase, type TestDatabase } from "./testing";

let db: TestDatabase;
let dir: string;
beforeEach(async () => {
  db = await createTestDatabase();
  dir = await mkdtemp(path.join(tmpdir(), "mig-"));
});
afterEach(async () => {
  await db.drop();
  await rm(dir, { recursive: true, force: true });
});

const put = (name: string, sql: string) => writeFile(path.join(dir, name), sql);
async function tables(): Promise<string[]> {
  const c = new pg.Client({ connectionString: db.url() });
  await c.connect();
  const { rows } = await c.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname='public' ORDER BY 1");
  await c.end();
  return rows.map((r) => r.t);
}

describe("migrate", () => {
  it("applies pending migrations in order and skips them on the next run", async () => {
    await put("0001_a.sql", "CREATE TABLE a (id int);");
    await put("0002_b.sql", "CREATE TABLE b (id int);");
    expect(await migrate(db.url(), dir)).toEqual({ applied: ["0001_a.sql", "0002_b.sql"], skipped: [] });
    expect(await migrate(db.url(), dir)).toEqual({ applied: [], skipped: ["0001_a.sql", "0002_b.sql"] });
    expect(await tables()).toEqual(["a", "b", "schema_migrations"]);
  });

  it("refuses a migration edited after it was applied", async () => {
    await put("0001_a.sql", "CREATE TABLE a (id int);");
    await migrate(db.url(), dir);
    await put("0001_a.sql", "CREATE TABLE a (id bigint);");
    await expect(migrate(db.url(), dir)).rejects.toThrow(/edited after it was applied/);
  });

  it("refuses when an applied migration's file is missing", async () => {
    await put("0001_a.sql", "CREATE TABLE a (id int);");
    await migrate(db.url(), dir);
    await rm(path.join(dir, "0001_a.sql"));
    await put("0002_b.sql", "SELECT 1;");
    await expect(migrate(db.url(), dir)).rejects.toThrow(MigrationError);
  });

  it("rolls back a failing migration and does not record it", async () => {
    await put("0001_a.sql", "CREATE TABLE a (id int);");
    await put("0002_bad.sql", "CREATE TABLE b (id int); SELECT * FROM does_not_exist;");
    await expect(migrate(db.url(), dir)).rejects.toThrow(/0002_bad\.sql failed/);
    expect(await tables()).toEqual(["a", "schema_migrations"]);
  });

  it("rejects badly named or non-contiguous files", async () => {
    await put("0001_a.sql", "SELECT 1;");
    await put("0003_c.sql", "SELECT 1;");
    await expect(migrate(db.url(), dir)).rejects.toThrow(/expected 0002/);
    await rm(path.join(dir, "0003_c.sql"));
    await put("2_Bad-Name.sql", "SELECT 1;");
    await expect(migrate(db.url(), dir)).rejects.toThrow(/NNNN_lower_snake/);
  });
});
```

`packages/db/src/schema.test.ts`:
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

async function as<T>(role: DbRole, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: db.url(role) });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}

describe("Phase 0 schema and grants", () => {
  it("installs citext and pg_trgm", async () => {
    const rows = await as<{ extname: string }>("lume_app", "SELECT extname FROM pg_extension ORDER BY 1");
    expect(rows.map((r) => r.extname)).toEqual(expect.arrayContaining(["citext", "pg_trgm"]));
  });

  it("lets api and worker read the queue schema; creates every queue", async () => {
    for (const role of ["lume_app", "lume_worker"] as const) {
      expect((await as<{ version: number }>(role, "SELECT version FROM pgboss.version")).length).toBe(1);
    }
    const queues = await as<{ name: string }>("lume_worker", "SELECT name FROM pgboss.queue ORDER BY 1");
    // Our queues plus pg-boss's internal cron queue, which only lume_owner may create.
    expect(queues.map((q) => q.name).sort()).toEqual([...QUEUE_NAMES, "__pgboss__send-it"].sort());
  });

  it("restore-test results: worker inserts, api cannot, nobody updates", async () => {
    await as(
      "lume_worker",
      "INSERT INTO ops_restore_tests (started_at, finished_at, backup_name, ok) VALUES (now(), now(), 'x', true)",
    );
    await expect(
      as(
        "lume_app",
        "INSERT INTO ops_restore_tests (started_at, finished_at, backup_name, ok) VALUES (now(), now(), 'x', true)",
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(as("lume_worker", "UPDATE ops_restore_tests SET ok = false")).rejects.toThrow(
      /permission denied/,
    );
    expect((await as<{ ok: boolean }>("lume_app", "SELECT ok FROM ops_restore_tests")).length).toBe(1);
  });

  it("backup role reads everything but writes nothing", async () => {
    expect((await as("lume_readonly_backup", "SELECT name FROM schema_migrations")).length).toBe(4);
    expect((await as("lume_readonly_backup", "SELECT count(*) FROM pgboss.job")).length).toBe(1);
    await expect(as("lume_readonly_backup", "DELETE FROM ops_restore_tests")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("app and worker cannot create tables in public", async () => {
    await expect(as("lume_app", "CREATE TABLE sneaky (id int)")).rejects.toThrow(/permission denied/);
    await expect(as("lume_worker", "CREATE TABLE sneaky (id int)")).rejects.toThrow(/permission denied/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `scripts/dev.sh add --filter @lume/db pg-boss@^10 "@lume/core@workspace:*" && scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile && pnpm vitest run packages/db'`
Expected: FAIL, cannot resolve `./migrate`.

- [ ] **Step 3: Implement the runner**

`packages/db/src/migrate.ts`:
```ts
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export class MigrationError extends Error {
  override name = "MigrationError";
}

export type Migration = { name: string; sql: string; checksum: string };
export type MigrationResult = { applied: string[]; skipped: string[] };

export const MIGRATIONS_DIR_DEFAULT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;
const LOCK_KEY = 727_272; // one migrator at a time

export async function listMigrations(dir: string): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  files.forEach((f, i) => {
    const m = FILE_RE.exec(f);
    if (!m) throw new MigrationError(`${f}: migration files must be named NNNN_lower_snake.sql`);
    const expected = String(i + 1).padStart(4, "0");
    if (m[1] !== expected) throw new MigrationError(`${f}: expected ${expected}_*.sql next (no gaps, no duplicates)`);
  });
  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(path.join(dir, name), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }),
  );
}

/** Apply pending migrations, each in its own transaction. Forward-only; edited or missing files are refused. */
export async function migrate(connectionString: string, dir: string): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations");
    const done = new Map(rows.map((r) => [r.name, r.checksum]));
    const all = await listMigrations(dir);
    for (const name of done.keys()) {
      if (!all.some((m) => m.name === name)) throw new MigrationError(`${name} was applied but its file is missing`);
    }
    const result: MigrationResult = { applied: [], skipped: [] };
    for (const m of all) {
      const prev = done.get(m.name);
      if (prev !== undefined) {
        if (prev !== m.checksum) {
          throw new MigrationError(`${m.name} was edited after it was applied (checksum mismatch). Write a new migration instead.`);
        }
        result.skipped.push(m.name);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [m.name, m.checksum]);
        await client.query("COMMIT");
        result.applied.push(m.name);
      } catch (e) {
        await client.query("ROLLBACK");
        throw new MigrationError(`${m.name} failed: ${(e as Error).message}`);
      }
    }
    return result;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}
```

`packages/db/src/queue-install.ts`:
```ts
import PgBoss from "pg-boss";

/** pg-boss 10's internal cron delivery queue (timekeeper.js QUEUES.SEND_IT). Pinned by tests. */
export const PGBOSS_CRON_QUEUE = "__pgboss__send-it";

/**
 * Install/upgrade pg-boss's schema and create our queues as lume_owner.
 * Queues are partitions of pgboss.job, which only the table owner may create,
 * so the worker (lume_worker) runs with migrate: false and never creates queues itself.
 */
export async function installQueueSchema(ownerUrl: string, queues: readonly string[]): Promise<void> {
  const boss = new PgBoss({
    connectionString: ownerUrl,
    schema: "pgboss",
    supervise: false,
    schedule: false,
  });
  boss.on("error", () => undefined);
  await boss.start();
  try {
    // pg-boss delivers cron jobs through this internal queue and creates it at worker start, but
    // silently gives up without schema rights (lume_worker has none). Create it here as the owner.
    if (!(await boss.getQueue(PGBOSS_CRON_QUEUE))) await boss.createQueue(PGBOSS_CRON_QUEUE);
    for (const name of queues) {
      if (!(await boss.getQueue(name))) {
        await boss.createQueue(name, { name, retryLimit: 5, retryDelay: 60, retryBackoff: true });
      }
    }
  } finally {
    await boss.stop({ graceful: false, wait: true });
  }
}
```

`packages/db/src/cli.ts`:
```ts
import { loadConfig, migrateSchema } from "@lume/config";
import { QUEUE_NAMES } from "@lume/core";
import { migrate } from "./migrate";
import { installQueueSchema } from "./queue-install";

/** `migrate` container entrypoint: queue schema first (0004 grants on it), then SQL migrations. */
export async function runMigrateCommand(env: Record<string, string | undefined> = process.env): Promise<void> {
  const cfg = loadConfig(migrateSchema, env);
  await installQueueSchema(cfg.DATABASE_URL_OWNER, QUEUE_NAMES);
  const result = await migrate(cfg.DATABASE_URL_OWNER, cfg.MIGRATIONS_DIR);
  console.log(JSON.stringify({ level: "info", msg: "migrations complete", ...result }));
}
```

`packages/db/src/index.ts`:
```ts
export * from "./testing";
export * from "./migrate";
export * from "./queue-install";
export * from "./cli";
```
Run: `scripts/dev.sh add --filter @lume/db "@lume/config@workspace:*"`

- [ ] **Step 4: Write the migrations**

`packages/db/migrations/0001_extensions.sql`:
```sql
-- Trusted extensions; the database owner (lume_owner) may create them.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

`packages/db/migrations/0002_grants.sql`:
```sql
-- Baseline privileges (report §12.4). Tables are created by lume_owner; these defaults make every
-- future table usable by the app and worker, readable by the backup role, and creatable by no one else.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO lume_app, lume_worker, lume_readonly_backup;

ALTER DEFAULT PRIVILEGES FOR ROLE lume_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lume_app, lume_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE lume_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO lume_app, lume_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE lume_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO lume_readonly_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE lume_owner IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO lume_readonly_backup;

GRANT SELECT ON schema_migrations TO lume_readonly_backup;
```

`packages/db/migrations/0003_ops_restore_tests.sql`:
```sql
-- One row per automated restore test (report §12.7), shown on System health in Phase 3. Append-only.
CREATE TABLE ops_restore_tests (
  id          bigserial PRIMARY KEY,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  backup_name text        NOT NULL,
  ok          boolean     NOT NULL,
  details     jsonb       NOT NULL DEFAULT '{}'::jsonb
);
REVOKE INSERT, UPDATE, DELETE ON ops_restore_tests FROM lume_app;
REVOKE UPDATE, DELETE ON ops_restore_tests FROM lume_worker;
```

`packages/db/migrations/0004_queue_grants.sql`:
```sql
-- pg-boss schema is installed (and queues created) by lume_owner in the migrate step, before migrations run.
GRANT USAGE ON SCHEMA pgboss TO lume_app, lume_worker, lume_readonly_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO lume_app, lume_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO lume_app, lume_worker;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO lume_app, lume_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA pgboss TO lume_readonly_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE lume_owner IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lume_app, lume_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE lume_owner IN SCHEMA pgboss
  GRANT SELECT ON TABLES TO lume_readonly_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE lume_owner IN SCHEMA pgboss
  GRANT USAGE, SELECT ON SEQUENCES TO lume_app, lume_worker;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile && pnpm vitest run packages/db && pnpm typecheck && pnpm lint'`
Expected: `migrate.test.ts` (5), `schema.test.ts` (5) and `roles.test.ts` (2) all pass.

If pg-boss's `createQueue` options type rejects the `name` key, drop `name` from the options object (it is passed as the first argument). Keep `retryLimit: 5` (report §10.4).

- [ ] **Step 6: Commit**

```bash
git add packages/db pnpm-lock.yaml
git commit -m "feat(db): checksummed forward-only migrations, Phase 0 grants, queue schema install

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: API — server factory, route guard, health endpoints

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/server.ts`, `apps/api/src/route-guard.ts`, `apps/api/src/errors.ts`, `apps/api/src/health.ts`, `apps/api/src/logger.ts`, `apps/api/src/main.ts`
- Test: `apps/api/src/server.test.ts`, `apps/api/src/readyz.integration.test.ts`

**Interfaces:**
- Consumes: `apiSchema`, `loadConfig` (`@lume/config`); `createTestDatabase`, `installQueueSchema`, `migrate`, `MIGRATIONS_DIR_DEFAULT` (`@lume/db`, tests only).
- Produces:
  - `buildServer(deps: ServerDeps): Promise<FastifyInstance>` where `ServerDeps = { checks: Record<string, ReadinessCheck>; readinessTimeoutMs?: number; logger?: FastifyServerOptions["logger"]; register?: (app: FastifyInstance) => void | Promise<void> }` and `ReadinessCheck = () => Promise<unknown>`
  - `RouteDeclarationError`
  - `REDACT_PATHS: string[]`
  - route config augmentation `{ permission?: string; public?: boolean }`, which every later route must use

- [ ] **Step 1: Package setup**

`apps/api/package.json`:
```json
{
  "name": "@lume/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "build": "node ../../scripts/bundle.mjs . src/main.ts dist/main.js"
  }
}
```
`apps/api/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```
Run: `scripts/dev.sh add --filter @lume/api fastify@^5 pg@^8 "@lume/config@workspace:*" && scripts/dev.sh add --filter @lume/api -D @types/pg@^8 "@lume/db@workspace:*" "@lume/core@workspace:*"`

- [ ] **Step 2: Write failing unit tests**

`apps/api/src/server.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { RouteDeclarationError } from "./route-guard";
import { buildServer } from "./server";

const ok = async () => undefined;
const fail = async () => {
  throw new Error("password=hunter2 connection refused");
};

describe("health", () => {
  it("GET /healthz is 200 without touching dependencies", async () => {
    const app = await buildServer({ checks: { database: fail } });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("GET /readyz is 200 when every check passes", async () => {
    const app = await buildServer({ checks: { database: ok, queue: ok } });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", checks: { database: "ok", queue: "ok" } });
    await app.close();
  });

  it("GET /readyz is 503 on failure and never leaks the error text", async () => {
    const app = await buildServer({ checks: { database: fail, queue: ok } });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "unavailable", checks: { database: "fail", queue: "ok" } });
    expect(res.body).not.toContain("hunter2");
    await app.close();
  });

  it("GET /readyz treats a hanging check as failed", async () => {
    const hang = () => new Promise(() => undefined);
    const app = await buildServer({ checks: { database: hang }, readinessTimeoutMs: 50 });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe("route declarations (report §7.4)", () => {
  it("boot fails if any route lacks a permission or public declaration", async () => {
    await expect(
      buildServer({ checks: {}, register: (app) => void app.get("/api/v1/leads", async () => []) }),
    ).rejects.toThrow(RouteDeclarationError);
  });

  it("routes that declare a permission are accepted", async () => {
    const app = await buildServer({
      checks: {},
      register: (a) => void a.get("/api/v1/leads", { config: { permission: "leads.view" } }, async () => []),
    });
    await app.close();
  });
});

describe("errors (report §4.4)", () => {
  it("unknown routes return the standard error shape", async () => {
    const app = await buildServer({ checks: {} });
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } });
    await app.close();
  });

  it("unexpected errors are 500 with no internals", async () => {
    const app = await buildServer({
      checks: {},
      register: (a) =>
        void a.get("/boom", { config: { public: true } }, async () => {
          throw new Error("SELECT * FROM secret_table");
        }),
    });
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" } });
    expect(res.body).not.toContain("secret_table");
    await app.close();
  });
});
```

`apps/api/src/readyz.integration.test.ts`:
```ts
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import { MIGRATIONS_DIR_DEFAULT, createTestDatabase, installQueueSchema, migrate } from "@lume/db";
import { buildServer } from "./server";
import { dbChecks } from "./health";

describe("/readyz against real Postgres as lume_app", () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterAll(async () => {
    for (const f of cleanup.reverse()) await f();
  });

  it("is 200 when the DB and queue schema are reachable, 503 once the DB is gone", async () => {
    const db = await createTestDatabase();
    await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
    await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
    const pool = new pg.Pool({ connectionString: db.url("lume_app"), max: 2 });
    pool.on("error", () => undefined);
    const app = await buildServer({ checks: dbChecks(pool), readinessTimeoutMs: 2000 });
    cleanup.push(() => app.close(), () => pool.end().catch(() => undefined));

    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    await db.drop();
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(503);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile && pnpm vitest run apps/api'`
Expected: FAIL, cannot resolve `./server`.

- [ ] **Step 4: Implement**

`apps/api/src/route-guard.ts`:
```ts
import type { FastifyInstance, RouteOptions } from "fastify";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Permission key from the catalog (report §7.2). Required unless `public: true`. */
    permission?: string;
    /** Explicitly unauthenticated (health checks, login, webhooks with their own signatures). */
    public?: boolean;
  }
}

export class RouteDeclarationError extends Error {
  override name = "RouteDeclarationError";
}

/** Collect routes that declare neither a permission nor `public: true`; call the returned assert after `ready()`. */
export function trackRouteDeclarations(app: FastifyInstance): () => void {
  const missing: string[] = [];
  app.addHook("onRoute", (route: RouteOptions) => {
    const cfg = (route.config ?? {}) as { permission?: string; public?: boolean };
    if (!cfg.public && !cfg.permission) missing.push(`${[route.method].flat().join(",")} ${route.url}`);
  });
  return () => {
    if (missing.length) {
      throw new RouteDeclarationError(`Routes without a permission or public declaration:\n  ${missing.join("\n  ")}`);
    }
  };
}
```

`apps/api/src/errors.ts`:
```ts
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

export type ErrorBody = { error: { code: string; message: string; details?: unknown } };

export function errorHandler(err: FastifyError, req: FastifyRequest, reply: FastifyReply): void {
  if (err.validation) {
    void reply.code(400).send({ error: { code: "VALIDATION_FAILED", message: "Request is invalid", details: err.validation } } satisfies ErrorBody);
    return;
  }
  const status = err.statusCode ?? 500;
  if (status < 500) {
    void reply.code(status).send({ error: { code: err.code ?? "BAD_REQUEST", message: err.message } } satisfies ErrorBody);
    return;
  }
  req.log.error({ err }, "unhandled error");
  void reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" } } satisfies ErrorBody);
}

export function notFoundHandler(_req: FastifyRequest, reply: FastifyReply): void {
  void reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found" } } satisfies ErrorBody);
}
```

`apps/api/src/health.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type pg from "pg";

export type ReadinessCheck = () => Promise<unknown>;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

export function healthRoutes(checks: Record<string, ReadinessCheck>, timeoutMs: number) {
  return async (app: FastifyInstance) => {
    app.get("/healthz", { config: { public: true } }, async () => ({ status: "ok" }));
    app.get("/readyz", { config: { public: true } }, async (_req, reply) => {
      const results = await Promise.all(
        Object.entries(checks).map(async ([name, check]) => {
          try {
            await withTimeout(check(), timeoutMs);
            return [name, "ok"] as const;
          } catch {
            return [name, "fail"] as const;
          }
        }),
      );
      const ok = results.every(([, s]) => s === "ok");
      return reply.code(ok ? 200 : 503).send({ status: ok ? "ok" : "unavailable", checks: Object.fromEntries(results) });
    });
  };
}

/** Readiness as the API's own DB role: the database answers and the queue schema is visible. */
export function dbChecks(pool: pg.Pool): Record<string, ReadinessCheck> {
  return {
    database: () => pool.query("SELECT 1"),
    queue: () => pool.query("SELECT version FROM pgboss.version"),
  };
}
```

`apps/api/src/logger.ts`:
```ts
/** pino redaction (report §4.3): never log contact data, credentials or cookies. */
export const REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  'res.headers["set-cookie"]',
  "*.password",
  "*.token",
  "*.secret",
  "*.phone",
  "*.email",
];
```

`apps/api/src/server.ts`:
```ts
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { errorHandler, notFoundHandler } from "./errors";
import { healthRoutes, type ReadinessCheck } from "./health";
import { trackRouteDeclarations } from "./route-guard";

export type ServerDeps = {
  checks: Record<string, ReadinessCheck>;
  readinessTimeoutMs?: number;
  logger?: FastifyServerOptions["logger"];
  /** Feature modules register here (Phase 1+). */
  register?: (app: FastifyInstance) => void | Promise<void>;
};

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, genReqId: () => randomUUID(), trustProxy: true, bodyLimit: 1_048_576 });
  const assertDeclared = trackRouteDeclarations(app);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  await app.register(healthRoutes(deps.checks, deps.readinessTimeoutMs ?? 2000));
  if (deps.register) await app.register(async (scope) => deps.register?.(scope));
  await app.ready();
  try {
    assertDeclared();
  } catch (e) {
    await app.close();
    throw e;
  }
  return app;
}
```

`apps/api/src/main.ts`:
```ts
import pg from "pg";
import { apiSchema, loadConfig } from "@lume/config";
import { dbChecks } from "./health";
import { REDACT_PATHS } from "./logger";
import { buildServer } from "./server";

const cfg = loadConfig(apiSchema);
const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL_APP, max: 10 });
const app = await buildServer({
  checks: dbChecks(pool),
  logger: { level: cfg.LOG_LEVEL, redact: { paths: REDACT_PATHS, censor: "[redacted]" } },
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

- [ ] **Step 5: Run the tests to verify they pass**

Run: `scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile && pnpm vitest run apps/api && pnpm typecheck && pnpm lint'`
Expected: 8 unit tests + 1 integration test pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat(api): Fastify factory with mandatory route declarations, health and readiness

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Backup retention and the worker

**Files:**
- Create: `packages/core/src/ops/retention.ts`; Modify: `packages/core/src/index.ts`
- Create: `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/src/exec.ts`, `apps/worker/src/ops.ts`, `apps/worker/src/boss.ts`, `apps/worker/src/main.ts`, `apps/worker/src/migrate.ts`
- Test: `packages/core/src/ops/retention.test.ts`, `apps/worker/src/ops.test.ts`, `apps/worker/src/boss.integration.test.ts`

**Interfaces:**
- Produces:
  - `backupName(at: Date): string` (format `lume-YYYYMMDDTHHMMZ.dump.age`)
  - `parseBackupTime(name: string): Date | null`
  - `selectBackupsToDelete(names: string[], now: Date): string[]`
  - `type Exec = (file: string, args: string[], env?: Record<string, string>) => Promise<string>` returning stdout
  - `makeOpsJobs(deps: OpsDeps): { backup(): Promise<BackupResult>; restoreTest(): Promise<RestoreTestResult> }`
  - `startQueue(opts: { connectionString: string; jobs: OpsJobs; log: Logger }): Promise<PgBoss>`
  - Worker CLI: `node dist/main.js` (daemon) and `node dist/main.js run-now <ops.backup|ops.restore-test>`
  - `node dist/migrate.js`

- [ ] **Step 1: Write failing retention tests**

`packages/core/src/ops/retention.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { backupName, parseBackupTime, selectBackupsToDelete } from "./retention";

const now = new Date("2026-09-21T12:00:00Z");
const H = 3_600_000;
const at = (msAgo: number) => backupName(new Date(now.getTime() - msAgo));

describe("backupName / parseBackupTime", () => {
  it("round-trips at minute precision in UTC", () => {
    const n = backupName(new Date("2026-09-21T06:05:59Z"));
    expect(n).toBe("lume-20260921T0605Z.dump.age");
    expect(parseBackupTime(n)?.toISOString()).toBe("2026-09-21T06:05:00.000Z");
    expect(parseBackupTime("notes.txt")).toBeNull();
  });
});

describe("selectBackupsToDelete (7 daily-ish days, 4 weekly, 6 monthly)", () => {
  it("keeps every 6-hourly backup from the last 7 days", () => {
    const names = Array.from({ length: 28 }, (_, i) => at(i * 6 * H));
    expect(selectBackupsToDelete(names, now)).toEqual([]);
  });

  it("keeps only the newest backup of each older week, for 4 weeks", () => {
    const week2 = [at(9 * 24 * H), at(9 * 24 * H + 6 * H), at(10 * 24 * H)]; // same ISO week
    const del = selectBackupsToDelete([at(0), ...week2], now);
    expect(del.sort()).toEqual([week2[1], week2[2]].sort());
  });

  it("keeps the newest backup per month for 6 months, deletes older", () => {
    const monthly = Array.from({ length: 10 }, (_, i) => backupName(new Date(Date.UTC(2026, 8 - i, 1, 0, 0))));
    const del = selectBackupsToDelete(monthly, now);
    // 1st of Sep 2026 … Dec 2025. Weekly keeps Sep–Jun (4 newest weeks that have a backup);
    // monthly keeps Sep–Apr (6 newest months). Mar, Feb, Jan 2026 and Dec 2025 go.
    expect(del).toEqual(monthly.slice(6));
  });

  it("never deletes files it does not recognise", () => {
    expect(selectBackupsToDelete(["README", "lume-bad.dump.age"], now)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/dev.sh run pnpm vitest run packages/core`
Expected: FAIL, cannot resolve `./retention`.

- [ ] **Step 3: Implement retention**

`packages/core/src/ops/retention.ts`:
```ts
const NAME_RE = /^lume-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z\.dump\.age$/;
const DAY = 86_400_000;

export function backupName(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `lume-${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}T${p(at.getUTCHours())}${p(at.getUTCMinutes())}Z.dump.age`;
}

export function parseBackupTime(name: string): Date | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  return new Date(Date.UTC(y, mo - 1, d, h, mi));
}

/** Monday-based week number since the epoch (1970-01-05 was a Monday). */
const weekKey = (t: Date) => Math.floor((t.getTime() + 3 * DAY) / (7 * DAY));
const monthKey = (t: Date) => t.getUTCFullYear() * 12 + t.getUTCMonth();

/**
 * Report §12.7: keep 7 days of 6-hourly backups, the newest backup of each of the last 4 weeks,
 * and the newest of each of the last 6 months. Unrecognised files are never deleted.
 */
export function selectBackupsToDelete(names: string[], now: Date): string[] {
  const items = names
    .map((n) => ({ n, t: parseBackupTime(n) }))
    .filter((x): x is { n: string; t: Date } => x.t !== null)
    .sort((a, b) => b.t.getTime() - a.t.getTime());
  const keep = new Set<string>();
  for (const { n, t } of items) if (now.getTime() - t.getTime() <= 7 * DAY) keep.add(n);
  const newestPer = (key: (t: Date) => number, limit: number) => {
    const seen = new Set<number>();
    for (const { n, t } of items) {
      const k = key(t);
      if (seen.has(k)) continue;
      if (seen.size >= limit) break;
      seen.add(k);
      keep.add(n);
    }
  };
  newestPer(weekKey, 4);
  newestPer(monthKey, 6);
  return items.filter((x) => !keep.has(x.n)).map((x) => x.n);
}
```
Append to `packages/core/src/index.ts`:
```ts
export * from "./ops/retention";
```

- [ ] **Step 4: Run to verify retention passes**

Run: `scripts/dev.sh run pnpm vitest run packages/core`
Expected: all pass. If the monthly test's expectation disagrees, it's because the 4-weekly rule also keeps a backup: verify by hand which months are kept and fix the **test's comment and expectation** only if the implementation matches the report rule. The rule wins.

- [ ] **Step 5: Write failing worker tests**

`apps/worker/package.json`:
```json
{
  "name": "@lume/worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "build": "node ../../scripts/bundle.mjs . src/main.ts dist/main.js src/migrate.ts dist/migrate.js"
  }
}
```
`apps/worker/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```
Run: `scripts/dev.sh add --filter @lume/worker pg@^8 pg-boss@^10 pino@^9 "@lume/config@workspace:*" "@lume/core@workspace:*" "@lume/db@workspace:*" && scripts/dev.sh add --filter @lume/worker -D @types/pg@^8`

`apps/worker/src/ops.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { makeOpsJobs, type Exec } from "./ops";

const now = new Date("2026-09-21T12:00:00Z");
const base = { remote: "offsite:/b", scriptsDir: "/app/scripts", env: { X: "1" }, now: () => now };

describe("ops.backup", () => {
  it("dumps, lists the remote, and deletes only what retention selects", async () => {
    const calls: string[][] = [];
    const exec: Exec = vi.fn(async (file, args) => {
      calls.push([file, ...args]);
      if (file === "rclone" && args[0] === "lsf") {
        // Today's backup + the 1st of each of the last 6 months fill the 4 weekly and 6 monthly slots,
        // so the January 2025 backup is the only one retention may drop.
        const monthly = ["09", "08", "07", "06", "05", "04"].map((m) => `lume-2026${m}01T0000Z.dump.age`);
        return ["lume-20250101T0000Z.dump.age", "lume-20260921T1200Z.dump.age", ...monthly, "notes.txt"].join("\n") + "\n";
      }
      return '{"backup":"lume-20260921T1200Z.dump.age","bytes":10}\n';
    });
    const jobs = makeOpsJobs({ ...base, exec, recordRestoreTest: vi.fn() });
    const res = await jobs.backup();
    expect(res).toEqual({ name: "lume-20260921T1200Z.dump.age", bytes: 10, deleted: ["lume-20250101T0000Z.dump.age"] });
    expect(calls[0]?.[0]).toBe("/app/scripts/backup.sh");
    expect(calls).toContainEqual(["rclone", "deletefile", "offsite:/b/lume-20250101T0000Z.dump.age"]);
    expect(calls.some((c) => c.includes("offsite:/b/notes.txt"))).toBe(false);
  });
});

describe("ops.restore-test", () => {
  it("records a passing result", async () => {
    const record = vi.fn();
    const exec: Exec = async () => '{"ok":true,"backup":"lume-20260921T1200Z.dump.age","migrations":4,"tables":9}\n';
    await makeOpsJobs({ ...base, exec, recordRestoreTest: record }).restoreTest();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ ok: true, backupName: "lume-20260921T1200Z.dump.age", details: { migrations: 4, tables: 9 } }));
  });

  it("records a failure and rethrows so pg-boss retries", async () => {
    const record = vi.fn();
    const exec: Exec = async () => {
      throw Object.assign(new Error("restore failed"), { stdout: '{"ok":false,"error":"pg_restore failed"}\n' });
    };
    await expect(makeOpsJobs({ ...base, exec, recordRestoreTest: record }).restoreTest()).rejects.toThrow(/restore failed/);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ ok: false, details: { error: "pg_restore failed" } }));
  });
});
```

`apps/worker/src/boss.integration.test.ts`:
```ts
import { afterAll, describe, expect, it, vi } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import { MIGRATIONS_DIR_DEFAULT, createTestDatabase, installQueueSchema, migrate } from "@lume/db";
import { startQueue } from "./boss";

describe("worker queue as lume_worker", () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterAll(async () => {
    for (const f of cleanup.reverse()) await f();
  });

  it("starts without schema rights, schedules the ops crons and processes a job", async () => {
    const db = await createTestDatabase();
    cleanup.push(() => db.drop());
    await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
    await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);

    const backup = vi.fn(async () => ({ name: "x", bytes: 1, deleted: [] }));
    const log = { info: vi.fn(), error: vi.fn() };
    const boss = await startQueue({
      connectionString: db.url("lume_worker"),
      jobs: { backup, restoreTest: vi.fn() },
      log,
    });
    cleanup.push(() => boss.stop({ graceful: false, wait: true }));

    const schedules = await boss.getSchedules();
    expect(schedules.map((s) => [s.name, s.cron]).sort()).toEqual([
      ["ops.backup", "0 */6 * * *"],
      ["ops.restore-test", "0 4 * * 1"],
    ]);
    await boss.send("ops.backup", {});
    await vi.waitFor(() => expect(backup).toHaveBeenCalledTimes(1), { timeout: 15_000, interval: 250 });
    // Cron delivery goes through pg-boss's internal queue. pg-boss swallows the error when it can't
    // create it, so check it exists; otherwise scheduled backups would silently never fire.
    expect(await boss.getQueue("__pgboss__send-it")).toBeTruthy();
    expect(log.error).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile && pnpm vitest run apps/worker'`
Expected: FAIL, cannot resolve `./ops` / `./boss`.

- [ ] **Step 7: Implement the worker**

`apps/worker/src/exec.ts`:
```ts
import { execFile } from "node:child_process";

export type Exec = (file: string, args: string[], env?: Record<string, string>) => Promise<string>;

/** Run a program without a shell; resolve with stdout. On failure the error carries `stdout`. */
export const realExec: Exec = (file, args, env) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/tmp", ...env }, maxBuffer: 16 * 1024 * 1024, timeout: 30 * 60_000 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve(stdout);
    });
  });
```

`apps/worker/src/ops.ts`:
```ts
import path from "node:path";
import { backupName, selectBackupsToDelete } from "@lume/core";
import type { Exec } from "./exec";

export type { Exec } from "./exec";
export type BackupResult = { name: string; bytes: number; deleted: string[] };
export type RestoreTestResult = { startedAt: Date; finishedAt: Date; backupName: string; ok: boolean; details: Record<string, unknown> };
export type OpsJobs = { backup(): Promise<BackupResult>; restoreTest(): Promise<void> };

export type OpsDeps = {
  exec: Exec;
  /** rclone remote path, e.g. offsite:/var/lib/lume/offsite */
  remote: string;
  scriptsDir: string;
  /** Environment passed to the scripts (DB URLs, age recipients/identity, rclone config). */
  env: Record<string, string>;
  now: () => Date;
  recordRestoreTest: (r: RestoreTestResult) => Promise<void>;
};

function lastJsonLine(out: string): Record<string, unknown> {
  const line = out.trim().split("\n").filter(Boolean).pop() ?? "{}";
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { error: "unparseable script output" };
  }
}

export function makeOpsJobs(d: OpsDeps): OpsJobs {
  return {
    async backup() {
      const name = backupName(d.now());
      const out = lastJsonLine(await d.exec(path.join(d.scriptsDir, "backup.sh"), [], { ...d.env, RCLONE_REMOTE: d.remote, BACKUP_NAME: name }));
      const listing = await d.exec("rclone", ["lsf", "--files-only", d.remote], d.env);
      const deleted = selectBackupsToDelete(listing.split("\n").map((s) => s.trim()).filter(Boolean), d.now());
      for (const n of deleted) await d.exec("rclone", ["deletefile", `${d.remote}/${n}`], d.env);
      return { name, bytes: Number(out.bytes ?? 0), deleted };
    },
    async restoreTest() {
      const startedAt = d.now();
      let out: Record<string, unknown>;
      let failure: unknown = null;
      try {
        out = lastJsonLine(await d.exec(path.join(d.scriptsDir, "restore-test.sh"), [], { ...d.env, RCLONE_REMOTE: d.remote }));
      } catch (e) {
        failure = e;
        out = lastJsonLine(String((e as { stdout?: string }).stdout ?? ""));
      }
      const { ok, backup, ...details } = out;
      await d.recordRestoreTest({
        startedAt,
        finishedAt: d.now(),
        backupName: typeof backup === "string" && backup !== "" ? backup : "(none)",
        ok: failure === null && ok === true,
        details,
      });
      if (failure) throw failure;
      if (ok !== true) throw new Error(`restore test failed: ${JSON.stringify(details)}`);
    },
  };
}
```

`apps/worker/src/boss.ts`:
```ts
import PgBoss from "pg-boss";
import type { OpsJobs } from "./ops";

export type Logger = { info: (o: object, msg?: string) => void; error: (o: object, msg?: string) => void };

/** Start pg-boss as lume_worker (no schema rights: migrate: false) and wire the ops crons (report §12.7). */
export async function startQueue(opts: { connectionString: string; jobs: OpsJobs; log: Logger }): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: opts.connectionString, schema: "pgboss", migrate: false });
  boss.on("error", (err) => opts.log.error({ err }, "queue error"));
  await boss.start();
  await boss.schedule("ops.backup", "0 */6 * * *", {}, { tz: "UTC" });
  await boss.schedule("ops.restore-test", "0 4 * * 1", {}, { tz: "UTC" });
  await boss.work("ops.backup", { batchSize: 1 }, async () => {
    const r = await opts.jobs.backup();
    opts.log.info({ backup: r.name, bytes: r.bytes, deleted: r.deleted.length }, "backup complete");
  });
  await boss.work("ops.restore-test", { batchSize: 1 }, async () => {
    await opts.jobs.restoreTest();
    opts.log.info({}, "restore test passed");
  });
  return boss;
}
```

`apps/worker/src/main.ts`:
```ts
import pg from "pg";
import pino from "pino";
import { loadConfig, workerSchema } from "@lume/config";
import { startQueue } from "./boss";
import { realExec } from "./exec";
import { makeOpsJobs } from "./ops";

const cfg = loadConfig(workerSchema);
const log = pino({ level: cfg.LOG_LEVEL, redact: { paths: ["*.password", "*.token", "*.phone", "*.email"], censor: "[redacted]" } });
const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL_WORKER, max: 5 });

const passthrough = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("RCLONE_CONFIG_"))) as Record<string, string>;
const jobs = makeOpsJobs({
  exec: realExec,
  remote: cfg.RCLONE_REMOTE,
  scriptsDir: cfg.OPS_SCRIPTS_DIR,
  now: () => new Date(),
  env: {
    ...passthrough,
    DATABASE_URL_BACKUP: cfg.DATABASE_URL_BACKUP,
    DATABASE_URL_RESTORE: cfg.DATABASE_URL_RESTORE,
    BACKUP_AGE_RECIPIENTS: cfg.BACKUP_AGE_RECIPIENTS.join(","),
    BACKUP_AGE_IDENTITY_FILE: cfg.BACKUP_AGE_IDENTITY_FILE,
  },
  recordRestoreTest: async (r) => {
    await pool.query(
      "INSERT INTO ops_restore_tests (started_at, finished_at, backup_name, ok, details) VALUES ($1, $2, $3, $4, $5)",
      [r.startedAt, r.finishedAt, r.backupName, r.ok, JSON.stringify(r.details)],
    );
  },
});

const [command, target] = process.argv.slice(2);
if (command === "run-now") {
  // Operator/acceptance entry: run one ops job immediately, outside the queue.
  try {
    if (target === "ops.backup") log.info(await jobs.backup(), "backup complete");
    else if (target === "ops.restore-test") {
      await jobs.restoreTest();
      log.info({}, "restore test passed");
    }
    else throw new Error(`unknown job ${target ?? "(none)"}`);
    await pool.end();
    process.exit(0);
  } catch (err) {
    log.error({ err }, "run-now failed");
    await pool.end();
    process.exit(1);
  }
} else {
  const boss = await startQueue({ connectionString: cfg.DATABASE_URL_WORKER, jobs, log });
  log.info({}, "worker started");
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, async () => {
      await boss.stop({ graceful: true, timeout: 20_000, wait: true });
      await pool.end();
      process.exit(0);
    });
  }
}
```

`apps/worker/src/migrate.ts`:
```ts
import { runMigrateCommand } from "@lume/db";

try {
  await runMigrateCommand();
  process.exit(0);
} catch (err) {
  console.error(JSON.stringify({ level: "error", msg: "migration failed", error: (err as Error).message }));
  process.exit(1);
}
```

- [ ] **Step 8: Run to verify all pass**

Run: `scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile && pnpm vitest run packages/core apps/worker && pnpm typecheck && pnpm lint'`
Expected: retention (5), ops (3), boss integration (1) pass.

If pg-boss v10's `getSchedules()` returns `name`/`cron` under different keys, adjust **the test's mapping** to the library's documented field names. Don't change the cron values.

- [ ] **Step 9: Commit**

```bash
git add packages/core apps/worker pnpm-lock.yaml
git commit -m "feat(worker): pg-boss ops crons, backup retention, restore-test recording

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Backup and restore-test scripts

**Files:**
- Create: `infra/scripts/backup.sh`, `infra/scripts/restore-test.sh`
- Test: `apps/worker/src/scripts.integration.test.ts`

**Interfaces:**
- Consumes: `realExec` (Task 7), `createTestDatabase`, `roleUrl`, `installQueueSchema`, `migrate` (`@lume/db`).
- Produces:
  - `backup.sh`: env `DATABASE_URL_BACKUP`, `BACKUP_AGE_RECIPIENTS` (comma list), `RCLONE_REMOTE`, `BACKUP_NAME`. Prints `{"backup":"<name>","bytes":<n>}`.
  - `restore-test.sh`: env `DATABASE_URL_RESTORE` (db `postgres`), `BACKUP_AGE_IDENTITY_FILE`, `RCLONE_REMOTE`. Prints `{"ok":true,"backup":…,"migrations":n,"tables":n}`, or `{"ok":false,"error":…}` with exit 1.

- [ ] **Step 1: Write the failing integration test**

`apps/worker/src/scripts.integration.test.ts`:
```ts
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES, backupName } from "@lume/core";
import { MIGRATIONS_DIR_DEFAULT, createTestDatabase, installQueueSchema, migrate, roleUrl, type TestDatabase } from "@lume/db";
import { realExec } from "./exec";

const SCRIPTS = path.resolve(import.meta.dirname, "../../../infra/scripts");
let db: TestDatabase;
let work: string;
let offline: { pub: string; file: string };
let restore: { pub: string; file: string };

async function agekey(name: string) {
  const file = path.join(work, `${name}.key`);
  const out = await realExec("age-keygen", ["-o", file]);
  const pub = /age1[0-9a-z]+/.exec(out + (await realExec("age-keygen", ["-y", file])))?.[0];
  if (!pub) throw new Error("no public key");
  return { pub, file };
}

beforeAll(async () => {
  work = await mkdtemp(path.join(tmpdir(), "bk-"));
  db = await createTestDatabase();
  await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
  await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
  offline = await agekey("offline");
  restore = await agekey("restore");
});
afterAll(async () => {
  await db.drop();
  await rm(work, { recursive: true, force: true });
});

describe("backup.sh → restore-test.sh", () => {
  it("writes an encrypted dump both keys can open, and the restore test passes", async () => {
    const remoteDir = path.join(work, "offsite");
    const rclone = { RCLONE_CONFIG_OFFSITE_TYPE: "local" };
    const remote = `offsite:${remoteDir}`;
    const name = backupName(new Date());

    const out = await realExec(path.join(SCRIPTS, "backup.sh"), [], {
      ...rclone,
      DATABASE_URL_BACKUP: roleUrl("lume_readonly_backup", db.name),
      BACKUP_AGE_RECIPIENTS: `${offline.pub},${restore.pub}`,
      RCLONE_REMOTE: remote,
      BACKUP_NAME: name,
    });
    expect(JSON.parse(out.trim())).toMatchObject({ backup: name });
    expect(await readdir(remoteDir)).toEqual([name]);

    // The owner's offline key can open it and it is a real custom-format dump.
    const plain = path.join(work, "check.dump");
    await realExec("age", ["-d", "-i", offline.file, "-o", plain, path.join(remoteDir, name)]);
    expect(await realExec("pg_restore", ["--list", plain])).toMatch(/schema_migrations/);

    const result = JSON.parse(
      (
        await realExec(path.join(SCRIPTS, "restore-test.sh"), [], {
          ...rclone,
          DATABASE_URL_RESTORE: roleUrl("lume_restore", "postgres"),
          BACKUP_AGE_IDENTITY_FILE: restore.file,
          RCLONE_REMOTE: remote,
        })
      ).trim(),
    );
    expect(result).toMatchObject({ ok: true, backup: name, migrations: 4 });
    expect(result.tables).toBeGreaterThanOrEqual(3);
  });

  it("restore-test.sh fails cleanly when there is no backup", async () => {
    const empty = path.join(work, "empty");
    await writeFile(path.join(work, ".keep"), "");
    await expect(
      realExec(path.join(SCRIPTS, "restore-test.sh"), [], {
        RCLONE_CONFIG_OFFSITE_TYPE: "local",
        DATABASE_URL_RESTORE: roleUrl("lume_restore", "postgres"),
        BACKUP_AGE_IDENTITY_FILE: restore.file,
        RCLONE_REMOTE: `offsite:${empty}`,
      }),
    ).rejects.toMatchObject({ stdout: expect.stringContaining('"ok":false') });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/dev.sh run pnpm vitest run apps/worker/src/scripts.integration.test.ts`
Expected: FAIL, `ENOENT … backup.sh`.

- [ ] **Step 3: Implement the scripts**

`infra/scripts/backup.sh`:
```bash
#!/usr/bin/env bash
# Dump the LUME database (as lume_readonly_backup), encrypt it to every age recipient, upload it off-site.
# Report §12.7. Called by the worker's ops.backup job.
set -euo pipefail
: "${DATABASE_URL_BACKUP:?}" "${BACKUP_AGE_RECIPIENTS:?}" "${RCLONE_REMOTE:?}" "${BACKUP_NAME:?}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

recipients=()
IFS=',' read -ra keys <<<"$BACKUP_AGE_RECIPIENTS"
for k in "${keys[@]}"; do
  k="${k//[[:space:]]/}"
  [ -n "$k" ] && recipients+=(-r "$k")
done
[ "${#recipients[@]}" -ge 4 ] || { echo '{"ok":false,"error":"need two age recipients"}'; exit 1; }

pg_dump --format=custom --compress=6 --dbname="$DATABASE_URL_BACKUP" | age "${recipients[@]}" -o "$work/$BACKUP_NAME"
bytes="$(stat -c %s "$work/$BACKUP_NAME")"
rclone copyto --no-traverse "$work/$BACKUP_NAME" "$RCLONE_REMOTE/$BACKUP_NAME"
printf '{"backup":"%s","bytes":%s}\n' "$BACKUP_NAME" "$bytes"
```

`infra/scripts/restore-test.sh`:
```bash
#!/usr/bin/env bash
# Weekly restore test (report §12.7): fetch the newest backup, decrypt with the restore-test key,
# restore into a scratch database as lume_restore, run sanity counts, drop the scratch database.
set -euo pipefail
: "${DATABASE_URL_RESTORE:?}" "${BACKUP_AGE_IDENTITY_FILE:?}" "${RCLONE_REMOTE:?}"

fail() { printf '{"ok":false,"backup":"%s","error":"%s"}\n' "${latest:-}" "$1"; exit 1; }

base="${DATABASE_URL_RESTORE%/*}"
scratch="lume_restore_test_$(date -u +%Y%m%d%H%M%S)"
work="$(mktemp -d)"
cleanup() {
  psql -q -X "$base/postgres" -c "DROP DATABASE IF EXISTS $scratch WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

latest="$(rclone lsf --files-only "$RCLONE_REMOTE" 2>/dev/null | grep -E '^lume-[0-9]{8}T[0-9]{4}Z\.dump\.age$' | sort | tail -n 1 || true)"
[ -n "$latest" ] || fail "no backups found"

rclone copyto "$RCLONE_REMOTE/$latest" "$work/backup.age" || fail "download failed"
age -d -i "$BACKUP_AGE_IDENTITY_FILE" -o "$work/backup.dump" "$work/backup.age" || fail "decrypt failed"
psql -q -X -v ON_ERROR_STOP=1 "$base/postgres" -c "CREATE DATABASE $scratch" >/dev/null || fail "createdb failed"
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$base/$scratch" "$work/backup.dump" >/dev/null 2>"$work/restore.err" \
  || fail "pg_restore failed: $(head -c 200 "$work/restore.err" | tr '"\n' "' ")"

migrations="$(psql -X -At "$base/$scratch" -c "SELECT count(*) FROM schema_migrations")"
tables="$(psql -X -At "$base/$scratch" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema IN ('public','pgboss')")"
if [ "$migrations" -lt 1 ] || [ "$tables" -lt 3 ]; then
  fail "sanity counts failed (migrations=$migrations tables=$tables)"
fi

printf '{"ok":true,"backup":"%s","migrations":%s,"tables":%s}\n' "$latest" "$migrations" "$tables"
```

Run: `chmod +x infra/scripts/*.sh` and `git update-index --chmod=+x infra/scripts/backup.sh infra/scripts/restore-test.sh scripts/dev.sh scripts/test-db.sh infra/postgres/init/00-roles.sh` (Windows loses the executable bit otherwise).

- [ ] **Step 4: Run to verify it passes**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/worker && shellcheck infra/scripts/*.sh'`
Expected: both script tests pass; shellcheck silent.

If `pg_restore` fails on the `public` schema comment or ACL, add `--no-comments` to the restore command, re-run, and note it in the commit message. Don't weaken the sanity counts.

- [ ] **Step 5: Commit**

```bash
git add infra/scripts apps/worker/src/scripts.integration.test.ts
git commit -m "feat(ops): age-encrypted off-site backups and an automated restore test

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Images, Caddy and the Compose stack

**Files:**
- Create: `scripts/bundle.mjs`
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/next.config.ts`, `apps/web/next-env.d.ts`, `apps/web/src/proxy.ts`, `apps/web/src/app/layout.tsx`, `apps/web/src/app/page.tsx`, `apps/web/public/lume-mark.png` (copy of `public/lume-mark.png`)
- Create: `infra/docker/api.Dockerfile`, `infra/docker/worker.Dockerfile`, `infra/docker/web.Dockerfile`, `infra/docker/caddy.Dockerfile`
- Create: `infra/Caddyfile`, `infra/docker-compose.yml`, `infra/compose.dev.yml`, `infra/.env.example`, `infra/scripts/gen-dev-env.sh`, `infra/scripts/smoke.sh`

**Interfaces:**
- Consumes: `apps/api` `build`, `apps/worker` `build` (dist/main.js, dist/migrate.js), migrations dir, ops scripts.
- Produces:
  - Images `lume/{api,worker,web,caddy}:dev` (built on lumedev) and `ghcr.io/kedar2812/lume-v3/<name>:<sha>` (CI)
  - Services `caddy, web, api, worker, db, migrate`
  - `https://lume.localhost:8443` via `scripts/dev.sh tunnel`

- [ ] **Step 1: Bundler**

`scripts/bundle.mjs`:
```js
// Bundle an app entrypoint (and its workspace packages + npm deps) into one ESM file, so runtime images need no node_modules.
import path from "node:path";
import { build } from "esbuild";

const [appDir, ...pairs] = process.argv.slice(2);
if (!appDir || pairs.length === 0 || pairs.length % 2 !== 0) {
  console.error("usage: bundle.mjs <appDir> <entry> <outfile> [<entry> <outfile> …]");
  process.exit(2);
}
const banner = [
  "import { createRequire as __lumeRequire } from 'node:module';",
  "import { fileURLToPath as __lumeFile } from 'node:url';",
  "import { dirname as __lumeDir } from 'node:path';",
  "const require = __lumeRequire(import.meta.url);",
  "const __filename = __lumeFile(import.meta.url);",
  "const __dirname = __lumeDir(__filename);",
].join("\n");

for (let i = 0; i < pairs.length; i += 2) {
  await build({
    entryPoints: [path.join(appDir, pairs[i])],
    outfile: path.join(appDir, pairs[i + 1]),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    sourcemap: true,
    legalComments: "none",
    external: ["pg-native"],
    banner: { js: banner },
    logLevel: "warning",
  });
}
```
Run: `scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile && pnpm --filter @lume/api build && pnpm --filter @lume/worker build && node -e "import(\"./apps/worker/dist/migrate.js\").catch(e=>{console.error(e);process.exit(3)})"'`
Expected: builds succeed. The migrate bundle exits 1 printing `migration failed … DATABASE_URL_OWNER`, which proves it loads and validates config.

- [ ] **Step 2: Minimal web app with a nonce CSP**

Run: `scripts/dev.sh add --filter @lume/web next@latest react@latest react-dom@latest && scripts/dev.sh add --filter @lume/web -D @types/react@latest @types/react-dom@latest`

`apps/web/package.json` (the `add` commands fill `dependencies`; add these fields around them):
```json
{
  "name": "@lume/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "typecheck": "next typegen && tsc -p tsconfig.json"
  }
}
```
`apps/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "preserve",
    "allowJs": false,
    "plugins": [{ "name": "next" }],
    "types": ["node", "react", "react-dom"]
  },
  "include": ["next-env.d.ts", "src", ".next/types/**/*.ts"]
}
```
`apps/web/next-env.d.ts` is generated by Next.js: add `apps/web/next-env.d.ts` to `.gitignore` instead of committing it.
`apps/web/next.config.ts`:
```ts
import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  poweredByHeader: false,
  reactStrictMode: true,
};
export default config;
```
`apps/web/src/proxy.ts`:
```ts
import { NextResponse, type NextRequest } from "next/server";

/** Per-request nonce CSP (report §12.3: no inline scripts). Inline style attributes are allowed for motion. */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const dev = process.env.NODE_ENV === "development";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico|lume-mark.png).*)" }],
};
```
`apps/web/src/app/layout.tsx`:
```tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "LUME", icons: { icon: "/lume-mark.png" } };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif" }}>{children}</body>
    </html>
  );
}
```
`apps/web/src/app/page.tsx`:
```tsx
export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#EEF0F3", color: "#0A0C11" }}>
      <div style={{ textAlign: "center" }}>
        <img src="/lume-mark.png" alt="" width={64} height={64} />
        <h1 style={{ letterSpacing: "0.14em", margin: "16px 0 4px" }}>LUME</h1>
        <p style={{ color: "#5A606D", margin: 0 }}>Foundations are up.</p>
      </div>
    </main>
  );
}
```
Run: `cp public/lume-mark.png apps/web/public/lume-mark.png`

(Next.js 16 renamed middleware to `proxy`; the file above is already `src/proxy.ts`.)

- [ ] **Step 3: Dockerfiles**

`infra/docker/api.Dockerfile`:
```dockerfile
FROM node:22-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @lume/api build

FROM node:22-bookworm-slim
ENV NODE_ENV=production NODE_OPTIONS="--max-old-space-size=512 --enable-source-maps"
WORKDIR /app
COPY --from=build /src/apps/api/dist ./dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
```

`infra/docker/worker.Dockerfile`:
```dockerfile
FROM node:22-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @lume/worker build

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg age rclone \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 \
 && apt-get purge -y curl gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NODE_OPTIONS="--max-old-space-size=512 --enable-source-maps"
WORKDIR /app
COPY --from=build /src/apps/worker/dist ./dist
COPY --from=build /src/packages/db/migrations ./migrations
COPY --from=build /src/infra/scripts/backup.sh /src/infra/scripts/restore-test.sh ./scripts/
# Owned by node so a fresh named volume mounted here inherits writable ownership.
RUN install -d -o node -g node /var/lib/lume/offsite
USER node
CMD ["node", "dist/main.js"]
```

`infra/docker/web.Dockerfile`:
```dockerfile
FROM node:22-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @lume/web build

FROM node:22-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build /src/apps/web/.next/standalone ./
COPY --from=build /src/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /src/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
```

`infra/docker/caddy.Dockerfile`:
```dockerfile
FROM caddy:2-builder AS build
RUN xcaddy build --with github.com/mholt/caddy-ratelimit

FROM caddy:2
COPY --from=build /usr/bin/caddy /usr/bin/caddy
```

- [ ] **Step 4: Caddyfile**

`infra/Caddyfile`:
```
{
	admin off
	order rate_limit before basic_auth
}

{$LUME_PUBLIC_HOST} {
	{$LUME_TLS}
	encode zstd gzip

	header {
		Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
		X-Frame-Options "DENY"
		-Server
		-X-Powered-By
	}

	rate_limit {
		zone per_ip {
			key {remote_host}
			events 600
			window 1m
		}
	}

	@api path /api/* /webhooks/* /healthz /readyz
	handle @api {
		# The API never serves HTML; the web app sets its own nonce CSP.
		header Content-Security-Policy "default-src 'none'; frame-ancestors 'none'"
		reverse_proxy api:3001
	}
	handle {
		reverse_proxy web:3000
	}

	log {
		output stdout
		format json
	}
}
```

- [ ] **Step 5: Compose files and env template**

`infra/docker-compose.yml` (production shape, report §4.1 and §15.1):
```yaml
name: lume

x-base: &base
  restart: unless-stopped
  security_opt: ["no-new-privileges:true"]
  logging:
    driver: json-file
    options: { max-size: "20m", max-file: "5" }

networks:
  frontend: {}
  backend:
    ipam:
      config: [{ subnet: 172.30.0.0/24 }]

volumes:
  pgdata: {}
  caddy_data: {}
  caddy_config: {}
  offsite: {}

secrets:
  restore_agekey:
    file: ${LUME_SECRETS_DIR:?}/restore.agekey

services:
  db:
    <<: *base
    image: postgres:17
    cap_drop: ["ALL"]
    cap_add: ["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER"]
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_SUPERUSER_PASSWORD:?}
      LUME_OWNER_PASSWORD: ${LUME_OWNER_PASSWORD:?}
      LUME_APP_PASSWORD: ${LUME_APP_PASSWORD:?}
      LUME_WORKER_PASSWORD: ${LUME_WORKER_PASSWORD:?}
      LUME_BACKUP_PASSWORD: ${LUME_BACKUP_PASSWORD:?}
      LUME_RESTORE_PASSWORD: ${LUME_RESTORE_PASSWORD:?}
    command: ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf", "-c", "hba_file=/etc/postgresql/pg_hba.conf"]
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./postgres/init:/docker-entrypoint-initdb.d:ro
      - ./postgres/postgresql.conf:/etc/postgresql/postgresql.conf:ro
      - ./postgres/pg_hba.conf:/etc/postgresql/pg_hba.conf:ro
    networks: [backend]
    shm_size: 256m
    mem_limit: 3g
    healthcheck:
      test: ["CMD", "pg_isready", "-q", "-h", "127.0.0.1", "-U", "postgres"]
      interval: 5s
      timeout: 3s
      retries: 30

  migrate:
    image: ${LUME_IMAGE_PREFIX:-lume}/worker:${LUME_TAG:-dev}
    command: ["node", "dist/migrate.js"]
    restart: "no"
    profiles: ["tools"]
    read_only: true
    cap_drop: ["ALL"]
    security_opt: ["no-new-privileges:true"]
    environment:
      DATABASE_URL_OWNER: postgres://lume_owner:${LUME_OWNER_PASSWORD:?}@db:5432/lume
    networks: [backend]
    depends_on:
      db: { condition: service_healthy }

  api:
    <<: *base
    image: ${LUME_IMAGE_PREFIX:-lume}/api:${LUME_TAG:-dev}
    read_only: true
    cap_drop: ["ALL"]
    tmpfs: ["/tmp"]
    environment:
      LUME_PUBLIC_HOST: ${LUME_PUBLIC_HOST:?}
      LUME_MASTER_KEY: ${LUME_MASTER_KEY:?}
      DATABASE_URL_APP: postgres://lume_app:${LUME_APP_PASSWORD:?}@db:5432/lume
      LOG_LEVEL: ${LOG_LEVEL:-info}
    networks: [frontend, backend]
    mem_limit: 768m
    depends_on:
      db: { condition: service_healthy }

  worker:
    <<: *base
    image: ${LUME_IMAGE_PREFIX:-lume}/worker:${LUME_TAG:-dev}
    read_only: true
    cap_drop: ["ALL"]
    tmpfs: ["/tmp:size=4g"]
    environment:
      LUME_MASTER_KEY: ${LUME_MASTER_KEY:?}
      DATABASE_URL_WORKER: postgres://lume_worker:${LUME_WORKER_PASSWORD:?}@db:5432/lume
      DATABASE_URL_BACKUP: postgres://lume_readonly_backup:${LUME_BACKUP_PASSWORD:?}@db:5432/lume
      DATABASE_URL_RESTORE: postgres://lume_restore:${LUME_RESTORE_PASSWORD:?}@db:5432/postgres
      BACKUP_AGE_RECIPIENTS: ${BACKUP_AGE_RECIPIENTS:?}
      BACKUP_AGE_IDENTITY_FILE: /run/secrets/restore_agekey
      RCLONE_CONFIG_OFFSITE_TYPE: ${RCLONE_CONFIG_OFFSITE_TYPE:-local}
      RCLONE_REMOTE: ${RCLONE_REMOTE:-offsite:/var/lib/lume/offsite}
      LOG_LEVEL: ${LOG_LEVEL:-info}
    secrets: [restore_agekey]
    volumes:
      - offsite:/var/lib/lume/offsite
    networks: [backend]
    mem_limit: 768m
    depends_on:
      db: { condition: service_healthy }

  web:
    <<: *base
    image: ${LUME_IMAGE_PREFIX:-lume}/web:${LUME_TAG:-dev}
    read_only: true
    cap_drop: ["ALL"]
    tmpfs: ["/tmp", "/app/apps/web/.next/cache"]
    networks: [frontend]
    mem_limit: 768m

  caddy:
    <<: *base
    image: ${LUME_IMAGE_PREFIX:-lume}/caddy:${LUME_TAG:-dev}
    cap_drop: ["ALL"]
    cap_add: ["NET_BIND_SERVICE"]
    environment:
      LUME_PUBLIC_HOST: ${LUME_PUBLIC_HOST:?}
      LUME_TLS: ${LUME_TLS:-}
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    networks: [frontend]
    mem_limit: 128m
    depends_on: [api, web]
```

`infra/compose.dev.yml` (build host overrides: local builds, 127.0.0.1 only, small limits ≈1.5 CPU / 3 GB):
```yaml
services:
  db:
    command: ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf", "-c", "hba_file=/etc/postgresql/pg_hba.conf",
              "-c", "shared_buffers=384MB", "-c", "effective_cache_size=768MB", "-c", "maintenance_work_mem=64MB"]
    mem_limit: 1g
    cpus: 0.5
  migrate:
    build: { context: .., dockerfile: infra/docker/worker.Dockerfile }
  api:
    build: { context: .., dockerfile: infra/docker/api.Dockerfile }
    mem_limit: 512m
    cpus: 0.3
  worker:
    build: { context: .., dockerfile: infra/docker/worker.Dockerfile }
    mem_limit: 512m
    cpus: 0.3
  web:
    build: { context: .., dockerfile: infra/docker/web.Dockerfile }
    mem_limit: 512m
    cpus: 0.3
  caddy:
    build: { context: .., dockerfile: infra/docker/caddy.Dockerfile }
    ports: !override
      - "127.0.0.1:8443:443"
      - "127.0.0.1:8080:80"
    mem_limit: 128m
    cpus: 0.1
```

`infra/.env.example`:
```
# Copy to the server as .env (chmod 600). Every value below is required unless marked optional.
LUME_PUBLIC_HOST=nupuur.example.com
# Empty in production (Let's Encrypt). "tls internal" for local/dev hosts.
LUME_TLS=
# openssl rand -base64 32
LUME_MASTER_KEY=
POSTGRES_SUPERUSER_PASSWORD=
LUME_OWNER_PASSWORD=
LUME_APP_PASSWORD=
LUME_WORKER_PASSWORD=
LUME_BACKUP_PASSWORD=
LUME_RESTORE_PASSWORD=
# Two age public keys, comma-separated: the owner's offline key, then the server's restore-test key.
BACKUP_AGE_RECIPIENTS=
# Directory holding restore.agekey (the restore-test private key), owned by uid 1000, mode 400.
LUME_SECRETS_DIR=/srv/lume/secrets
# Off-site storage via rclone env config; "local" keeps backups in the offsite volume.
RCLONE_CONFIG_OFFSITE_TYPE=local
RCLONE_REMOTE=offsite:/var/lib/lume/offsite
# Optional
LOG_LEVEL=info
LUME_IMAGE_PREFIX=ghcr.io/kedar2812/lume-v3
LUME_TAG=
```

- [ ] **Step 6: Dev env generator and smoke test**

`infra/scripts/gen-dev-env.sh`:
```bash
#!/usr/bin/env bash
# Build host only: create $LUME_DEV_ROOT/.env and the restore-test age key once. Idempotent.
# The "offline" dev key's private half is written to secrets/offline.agekey for the owner to fetch and delete.
set -euo pipefail
ROOT="${LUME_DEV_ROOT:?}"
SECRETS="$ROOT/secrets"
mkdir -p "$SECRETS" && chmod 700 "$SECRETS"
[ -f "$ROOT/.env" ] && { echo ".env exists, leaving it untouched"; exit 0; }

gen() { openssl rand -hex 24; }
keygen() { docker run --rm lumedev-toolbox:latest age-keygen 2>/dev/null; }

restore_key="$(keygen)"
offline_key="$(keygen)"
printf '%s\n' "$restore_key" > "$SECRETS/restore.agekey"
printf '%s\n' "$offline_key" > "$SECRETS/offline.agekey"
chown 1000:1000 "$SECRETS/restore.agekey" && chmod 400 "$SECRETS/restore.agekey"
chmod 400 "$SECRETS/offline.agekey"
pub() { grep -o 'age1[0-9a-z]*' <<<"$1" | head -n 1; }

umask 077
cat > "$ROOT/.env" <<EOF
LUME_PUBLIC_HOST=lume.localhost
LUME_TLS=tls internal
LUME_MASTER_KEY=$(openssl rand -base64 32)
POSTGRES_SUPERUSER_PASSWORD=$(gen)
LUME_OWNER_PASSWORD=$(gen)
LUME_APP_PASSWORD=$(gen)
LUME_WORKER_PASSWORD=$(gen)
LUME_BACKUP_PASSWORD=$(gen)
LUME_RESTORE_PASSWORD=$(gen)
BACKUP_AGE_RECIPIENTS=$(pub "$offline_key"),$(pub "$restore_key")
LUME_SECRETS_DIR=$SECRETS
RCLONE_CONFIG_OFFSITE_TYPE=local
RCLONE_REMOTE=offsite:/var/lib/lume/offsite
LOG_LEVEL=info
LUME_IMAGE_PREFIX=lume
LUME_TAG=dev
EOF
echo "generated $ROOT/.env and age keys (fetch secrets/offline.agekey to the owner's PC, then delete it)"
```

`infra/scripts/smoke.sh`:
```bash
#!/usr/bin/env bash
# Run on the host: HTTPS through Caddy, health, readiness, security headers, web page.
set -euo pipefail
HOSTNAME_="${LUME_PUBLIC_HOST:-lume.localhost}"
PORT="${SMOKE_PORT:-8443}"
base="https://$HOSTNAME_:$PORT"
c() { curl -sS -k --resolve "$HOSTNAME_:$PORT:127.0.0.1" "$@"; }
check() { # check <description> <command...>
  local desc="$1"; shift
  if "$@"; then printf '  ok  %s\n' "$desc"; else printf '  FAIL %s\n' "$desc"; exit 1; fi
}
status() { c -o /dev/null -w '%{http_code}' "$@"; }

check "GET /healthz 200" test "$(status "$base/healthz")" = 200
ready="$(c -w '\n%{http_code}' "$base/readyz")"
check "GET /readyz 200 ${ready%%$'\n'*}" test "${ready##*$'\n'}" = 200
headers="$(c -D - -o /dev/null "$base/")"
for h in "strict-transport-security: max-age=63072000" "x-content-type-options: nosniff" \
  "content-security-policy: default-src 'self'" "frame-ancestors 'none'"; do
  check "header $h" grep -qi "$h" <<<"$headers"
done
no_server_header() { ! grep -qi "^server:" <<<"$headers"; }
page_has_brand() { c "$base/" | grep -q LUME; }
check "no Server header" no_server_header
check "web page renders" page_has_brand
check "unknown API route 404" test "$(status -H 'Origin: https://evil.example' "$base/api/v1/nope")" = 404
echo "smoke passed"
```
Run: `git update-index --chmod=+x infra/scripts/gen-dev-env.sh infra/scripts/smoke.sh`

- [ ] **Step 7: Bring the stack up and run the smoke test**

Run:
```bash
scripts/dev.sh up
scripts/dev.sh ps
scripts/dev.sh remote bash infra/scripts/smoke.sh
ssh lumedev 'test -f /root/lume-dev/secrets/offline.agekey' && scp -q lumedev:/root/lume-dev/secrets/offline.agekey "$HOME/.lume-dev-offline.agekey" && ssh lumedev 'shred -u /root/lume-dev/secrets/offline.agekey'
```
Expected: `migrate` prints `migrations complete` with 4 applied. `ps` shows db/api/worker/web/caddy running (healthy). The smoke output ends with `smoke passed`. The offline dev key is now only on the PC at `~/.lume-dev-offline.agekey`.

Then confirm nothing listens publicly: `ssh lumedev "ss -tlnp | grep -E ':(8443|8080|5432)\b'"`. Expected: only `127.0.0.1:8443`, `127.0.0.1:8080` and the host's own `127.0.0.1:5432` (their Postgres 16). Never `0.0.0.0:8443`.

- [ ] **Step 8: Commit**

```bash
git add scripts/bundle.mjs apps/web infra/docker infra/Caddyfile infra/docker-compose.yml infra/compose.dev.yml infra/.env.example infra/scripts pnpm-lock.yaml
git commit -m "feat(infra): hardened compose stack behind Caddy with HTTPS, headers and rate limits

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: `bootstrap-server.sh`

**Files:**
- Create: `infra/scripts/bootstrap-server.sh`

**Interfaces:**
- Produces: `sudo bash bootstrap-server.sh [--dry-run] [--deploy-key "<ssh public key>"]`, idempotent, Ubuntu 24.04 only.

- [ ] **Step 1: Write the test harness command first and watch it fail**

Run: `scripts/dev.sh remote 'docker run --rm -v "$PWD/infra/scripts:/s:ro" ubuntu:24.04 bash /s/bootstrap-server.sh --dry-run'`
Expected: FAIL, `No such file or directory`.

- [ ] **Step 2: Implement**

`infra/scripts/bootstrap-server.sh`:
```bash
#!/usr/bin/env bash
# Harden a fresh Ubuntu 24.04 LUME server (report §12.6). Idempotent. NEVER run on the shared build host.
# Usage: sudo bash bootstrap-server.sh [--dry-run] [--deploy-key "ssh-ed25519 AAAA… name"]
set -euo pipefail

DRY=false
DEPLOY_KEY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=true ;;
    --deploy-key) DEPLOY_KEY="${2:?}"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

run() { if $DRY; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }
write() { # write <path> <mode> <content>
  if $DRY; then printf '[dry-run] write %s (%s)\n' "$1" "$2"; return; fi
  if [ -f "$1" ] && [ "$(cat "$1")" = "$3" ]; then return; fi
  install -m "$2" /dev/null "$1" && printf '%s\n' "$3" > "$1"
}
step() { printf '\n== %s\n' "$1"; }

# shellcheck source=/dev/null
. /etc/os-release
if [ "${ID:-}" != ubuntu ] || [ "${VERSION_ID:-}" != "24.04" ]; then
  echo "Ubuntu 24.04 required (found ${PRETTY_NAME:-unknown})" >&2; exit 1
fi
[ "$(id -u)" = 0 ] || $DRY || { echo "run as root" >&2; exit 1; }

step "packages"
run apt-get update -q
run env DEBIAN_FRONTEND=noninteractive apt-get install -y -q ca-certificates curl gnupg ufw fail2ban unattended-upgrades chrony

step "deploy user"
if ! id deploy >/dev/null 2>&1; then run adduser --disabled-password --gecos "" deploy; fi
run usermod -aG sudo deploy
if [ -n "$DEPLOY_KEY" ]; then
  run install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
  if $DRY || ! grep -qxF "$DEPLOY_KEY" /home/deploy/.ssh/authorized_keys 2>/dev/null; then
    if $DRY; then echo "[dry-run] add deploy key"; else printf '%s\n' "$DEPLOY_KEY" >> /home/deploy/.ssh/authorized_keys; fi
  fi
  run chown deploy:deploy /home/deploy/.ssh/authorized_keys
  run chmod 600 /home/deploy/.ssh/authorized_keys
fi

step "ssh: key-only, no root"
if ! $DRY && [ -z "$DEPLOY_KEY" ] && [ ! -s /home/deploy/.ssh/authorized_keys ]; then
  echo "refusing to disable root/password login: deploy has no SSH key (pass --deploy-key)" >&2; exit 1
fi
write /etc/ssh/sshd_config.d/10-lume.conf 644 "PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
X11Forwarding no
MaxAuthTries 3"
run sshd -t
run systemctl reload ssh

step "firewall"
run ufw default deny incoming
run ufw default allow outgoing
run ufw allow 22/tcp
run ufw allow 80/tcp
run ufw allow 443/tcp
run ufw --force enable

step "fail2ban, updates, time"
write /etc/fail2ban/jail.d/lume.local 644 "[sshd]
enabled = true
maxretry = 5
bantime = 1h"
run systemctl enable --now fail2ban chrony unattended-upgrades
run systemctl restart fail2ban

step "docker"
if ! command -v docker >/dev/null 2>&1; then
  run install -d -m 0755 /etc/apt/keyrings
  run curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  write /etc/apt/sources.list.d/docker.list 644 "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable"
  run apt-get update -q
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
write /etc/docker/daemon.json 644 '{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" },
  "no-new-privileges": true,
  "live-restore": true
}'
run usermod -aG docker deploy
run systemctl restart docker

step "swap (2 GB)"
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  [ -f /swapfile ] || run fallocate -l 2G /swapfile
  run chmod 600 /swapfile
  run mkswap /swapfile
  run swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab 2>/dev/null || { if $DRY; then echo "[dry-run] add /swapfile to fstab"; else echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi; }

step "LUME directories"
run install -d -m 750 -o deploy -g deploy /srv/lume
run install -d -m 700 -o 1000 -g 1000 /srv/lume/secrets

echo
if $DRY; then echo "bootstrap dry run complete: nothing changed"; else echo "bootstrap complete"; fi
```

- [ ] **Step 3: Run to verify: shellcheck + two dry runs in a disposable container**

Run:
```bash
scripts/dev.sh run shellcheck infra/scripts/bootstrap-server.sh
scripts/dev.sh remote 'for i in 1 2; do docker run --rm -v "$PWD/infra/scripts:/s:ro" ubuntu:24.04 bash /s/bootstrap-server.sh --dry-run >/tmp/bs$i.log 2>&1 || { cat /tmp/bs$i.log; exit 1; }; done; diff /tmp/bs1.log /tmp/bs2.log && tail -n 1 /tmp/bs2.log'
```
Expected: shellcheck silent. Both runs exit 0 with identical output, ending `bootstrap dry run complete: nothing changed`.

- [ ] **Step 4: Commit**

```bash
git add infra/scripts/bootstrap-server.sh
git commit -m "feat(infra): idempotent Ubuntu 24.04 hardening script with dry-run

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: CI on GitHub Actions

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `scripts/test-db.sh` (with `TEST_DB_PUBLISH`, `LUME_DEV_ROOT`), all package scripts, the Dockerfiles.
- Produces: `ghcr.io/kedar2812/lume-v3/{api,worker,web,caddy}:<git sha>` on every green push to `main`.

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:
```yaml
name: ci
on:
  push: { branches: [main, "phase-*"] }
  pull_request: {}
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc }
      - run: corepack enable
      - name: System tools (pg client 17, age, rclone, shellcheck)
        run: |
          sudo install -d /usr/share/postgresql-common/pgdg
          sudo curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
          echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list
          sudo apt-get update -q && sudo apt-get install -y -q postgresql-client-17 age rclone shellcheck
          # The runner's preinstalled client 16 wins on PATH otherwise, and pg_dump refuses a v17 server.
          echo /usr/lib/postgresql/17/bin >> "$GITHUB_PATH"
      - run: pnpm install --frozen-lockfile
      - run: pnpm audit --prod --audit-level high
      - run: pnpm lint
      - run: pnpm typecheck
      - run: shellcheck scripts/*.sh infra/scripts/*.sh infra/postgres/init/*.sh
      - name: Test database
        run: TEST_DB_PUBLISH=55432 LUME_DEV_ROOT="$RUNNER_TEMP" bash scripts/test-db.sh up
      - name: Tests
        run: |
          set -a && . "$RUNNER_TEMP/test.env" && set +a
          set -o pipefail
          pnpm test --reporter=default --reporter=github-actions 2>&1 | tee "$RUNNER_TEMP/test.out"
      - name: Failure details (public annotation)
        if: failure()
        run: |
          out="$(sed -r 's/\x1B\[[0-9;]*[A-Za-z]//g' "$RUNNER_TEMP/test.out" 2>/dev/null | grep -v '^\s*$' | tail -n 60 || true)"
          db="$(docker logs lumedev-pgtest 2>&1 | tail -n 15)"
          body="$(printf '%s\n--- pgtest ---\n%s' "$out" "$db")"
          body="${body//'%'/'%25'}"
          body="${body//$'\n'/'%0A'}"
          echo "::error title=test output::$body"
      - name: Bootstrap script dry run (twice, identical)
        run: |
          for i in 1 2; do docker run --rm -v "$PWD/infra/scripts:/s:ro" ubuntu:24.04 bash /s/bootstrap-server.sh --dry-run > "$RUNNER_TEMP/bs$i.log"; done
          diff "$RUNNER_TEMP/bs1.log" "$RUNNER_TEMP/bs2.log"

  images:
    needs: check
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-24.04
    permissions: { contents: read, packages: write }
    strategy:
      matrix:
        image: [api, worker, web, caddy]
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: "${{ github.actor }}", password: "${{ secrets.GITHUB_TOKEN }}" }
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: infra/docker/${{ matrix.image }}.Dockerfile
          push: true
          tags: ghcr.io/kedar2812/lume-v3/${{ matrix.image }}:${{ github.sha }}
          cache-from: type=gha,scope=${{ matrix.image }}
          cache-to: type=gha,mode=max,scope=${{ matrix.image }}
```

- [ ] **Step 2: Validate locally, then push**

Run: `scripts/dev.sh run bash -c 'npx --yes @action-validator/cli .github/workflows/ci.yml'`
Expected: no errors.

Then:
```bash
git add .github/workflows/ci.yml
git commit -m "ci: lint, typecheck, audit, shellcheck, Postgres-backed tests, images to GHCR

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 3: Verify the run is green**

The repo is private and `gh` isn't installed on the PC. Ask the owner to open **GitHub → lume-v3 → Actions**, confirm the `ci` run for this commit is green (both `check` and all four `images` jobs), and paste any failing job's log. Fix failures with a new commit and repeat until green.

---

### Task 12: Phase 0 acceptance on the build host + runbooks

**Files:**
- Create: `docs/runbooks/restore.md`, `docs/runbooks/phase0-acceptance.md`

- [ ] **Step 1: Run the acceptance script and capture output**

Run (each line separately, saving output):
```bash
scripts/dev.sh up
scripts/dev.sh remote bash infra/scripts/smoke.sh
scripts/dev.sh compose exec -T worker node dist/main.js run-now ops.backup
scripts/dev.sh compose exec -T worker node dist/main.js run-now ops.restore-test
scripts/dev.sh compose exec -T -u postgres db psql -U postgres -d lume -Atc "SELECT backup_name, ok, details FROM ops_restore_tests ORDER BY id DESC LIMIT 1"
scripts/dev.sh compose stop db && sleep 3 && scripts/dev.sh remote "curl -sk --resolve lume.localhost:8443:127.0.0.1 -o /dev/null -w '%{http_code}\n' https://lume.localhost:8443/readyz"
scripts/dev.sh compose start db && sleep 8 && scripts/dev.sh remote bash infra/scripts/smoke.sh
scripts/dev.sh compose exec -T worker sh -c 'ls -l /var/lib/lume/offsite'
```
Expected, in order:
- `smoke passed`
- backup log with a `lume-…dump.age` name and bytes > 0
- `restore test passed`
- a row `lume-…|t|{"tables": …, "migrations": 4}`
- `503` while the DB is stopped
- `smoke passed` again
- the encrypted file listed in the offsite volume

Also decrypt the newest backup with the owner's offline key on the build host, via stdin so the key never touches disk there:
```bash
f=$(ssh lumedev "docker run --rm -v lumedev_offsite:/o:ro alpine sh -c 'ls /o | sort | tail -n 1'")
ssh lumedev "docker run --rm -i -v lumedev_offsite:/o:ro lumedev-toolbox:latest bash -c 'age -d -i /dev/stdin /o/$f | pg_restore --list | head -5'" < "$HOME/.lume-dev-offline.agekey"
```
Expected: the `pg_restore --list` header lines (archive details). This proves the owner's offline key can recover the backup.

- [ ] **Step 2: Write the runbooks with the real outputs**

`docs/runbooks/restore.md`:
````markdown
# Restore runbook

**Objectives (report §12.7):** RPO ≤ 6 hours (backups every 6 h), RTO ≤ 2 hours.

## What exists
- Off-site: `lume-YYYYMMDDTHHMMZ.dump.age` in the rclone remote `offsite` (7 days of 6-hourly, 4 weekly, 6 monthly).
- Each file is encrypted to two age keys: the owner's **offline key** (kept off the server) and the server's restore-test key.
- Hostinger weekly snapshots as a second layer.
- Every Monday 04:00 UTC the worker restores the newest backup into a scratch database; results are in `ops_restore_tests`.

## Restore onto a new server (≈ 60–90 min)
1. Provision Ubuntu 24.04, run `infra/scripts/bootstrap-server.sh --deploy-key "<key>"`.
2. Put `.env` (from the password manager) and `secrets/restore.agekey` in `/srv/lume`, then `docker compose pull`.
3. Start only the database: `docker compose up -d db` (roles are created on first boot).
4. Fetch the newest backup with the worker image, which ships rclone and age (the host has neither):
   `docker compose run --rm --no-deps -v /tmp/lume-restore:/work worker sh -c 'rclone lsf "$RCLONE_REMOTE" | sort | tail -n 1'` to find the name, then
   `docker compose run --rm --no-deps -v /tmp/lume-restore:/work worker sh -c 'rclone copyto "$RCLONE_REMOTE/<name>" /work/b.age'`
   (or download it from the bucket UI into `/tmp/lume-restore/b.age`).
5. Decrypt on the server with the offline key streamed over SSH stdin, so the key never lands on disk:
   `ssh deploy@server 'cd /srv/lume && docker compose run --rm -T --no-deps -v /tmp/lume-restore:/work worker sh -c "age -d -i /dev/stdin -o /work/b.dump /work/b.age"' < offline.agekey`
6. Restore as the owner role:
   `docker compose exec -T -u postgres db pg_restore --clean --if-exists --no-owner --role=lume_owner -d lume < /tmp/lume-restore/b.dump`
7. `docker compose run --rm migrate` (a no-op if the schema is current), then `docker compose up -d`.
8. Verify: `https://<host>/readyz` is 200, spot-check lead counts, then `shred -u /tmp/lume-restore/b.dump /tmp/lume-restore/b.age`.
9. Record the incident and the restored backup's timestamp (data after it is lost, at most 6 h).
````

`docs/runbooks/phase0-acceptance.md`: record the date, the commit SHA, and the verbatim output of every command in Step 1, under the headings *HTTPS + headers*, *Health/readiness*, *Readiness when DB is down*, *Backup*, *Restore test*, *Offline-key decrypt*, *Bootstrap dry-run (CI)* and *CI run URL*. End with the line: **Status: accepted on temp build host. Final acceptance pending a fresh-VPS run on the production server (spec §4).**

- [ ] **Step 3: Commit and push**

```bash
git add docs/runbooks
git commit -m "docs: restore runbook and Phase 0 acceptance evidence

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 4: Demo to the owner**

Run `scripts/dev.sh tunnel`, open `https://lume.localhost:8443` (accept the local certificate), and show: the placeholder page with the logo, `/healthz`, `/readyz`, and the acceptance log. Ask the owner to confirm Phase 0A before Plan 0B starts.
