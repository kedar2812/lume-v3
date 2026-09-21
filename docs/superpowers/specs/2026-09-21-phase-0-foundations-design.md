# LUME Phase 0 — Foundations: Design

**Date:** 2026-09-21 · **Status:** approved in brainstorming
**Implements:** `docs/LUME_PROJECT_REPORT.md` §4, §12.4–12.7, §15, §17 Phase 0, plus the web foundation from `docs/superpowers/specs/2026-09-21-lume-frontend-design.md`.
The report is authoritative for everything it specifies. This document records only the decisions the report leaves open, and how Phase 0 is split and verified.

---

## 1. Split into two plans

| Plan | Delivers | Depends on |
|---|---|---|
| **0A — Infrastructure** | Monorepo, config validation, Docker Compose stack, Caddy, Postgres roles, migrations, `/healthz` + `/readyz`, pg-boss worker skeleton, backup + encrypted off-site copy + weekly restore test, bootstrap script, CI | — |
| **0B — Web foundation** | Design tokens (both themes), Inter, motion and sound libraries, theme switching, core components, app shell, sign-in UI, `/design` showcase with visual + a11y tests | 0A's monorepo and `apps/web` skeleton |

0A is executed first. 0B starts once 0A's monorepo task is merged (0B does not need the rest of 0A).

## 2. Development environment

- **Source of truth:** local git repo on the owner's PC → `origin` = `https://github.com/kedar2812/lume-v3.git` (**private**).
- **Build/test host (temporary):** `lumedev` (200.97.166.16). It is another client's live server, so these isolation rules are mandatory:
  - Nothing is installed on the host. All tooling runs in containers: `node:22-bookworm` with corepack pnpm, and `postgres:17`.
  - Work only in `/root/lume-dev`. Compose project name is always `lumedev`.
  - Every published port binds `127.0.0.1` (Docker publishing bypasses UFW). Viewing goes through an SSH tunnel.
  - Resource caps: ≈1.5 CPU / 3 GB across LUME containers. Builds run with `nice`.
  - `bootstrap-server.sh` is never executed on this host.
- **Wrapper `scripts/dev.sh`** (runs on the PC): `sync` (git push + remote fetch/reset to the pushed commit), `run <cmd>` (run inside the toolbox container on the server with the repo mounted), `up`/`down`/`logs` (compose with `-p lumedev`), `tunnel` (SSH port-forward of Caddy 127.0.0.1:8443 → PC).
- **Toolbox image** `lumedev-toolbox`: node:22-bookworm + pnpm (corepack) + postgresql-client-17 + age + rclone + shellcheck (no Docker socket is ever mounted) + Playwright browsers (added in 0B).

## 3. Stand-ins for open items (report §18)

| Open item | Phase 0 stand-in | Swap later by |
|---|---|---|
| LUME domain / client subdomain | `LUME_PUBLIC_HOST=lume.localhost`, Caddy `tls internal` | Set `LUME_PUBLIC_HOST` + remove `tls internal`, Caddy fetches Let's Encrypt |
| Backup storage (B2 vs R2) | rclone remote `offsite` of type `local` → `/var/lib/lume/offsite` volume | Edit `rclone.conf` `[offsite]` to b2/s3(R2), no code change |
| SMTP provider | Not needed in Phase 0 (env var validated as optional until Phase 1) | Phase 1 |
| `age` private key | Generated for dev, stored outside the repo on the owner's PC; public key in server `.env` | Owner generates the production key offline |

## 4. Phase 0 acceptance, adapted

Report criterion: *"`docker compose up` on a fresh Ubuntu VPS yields HTTPS, health checks pass, a backup is created, and the restore test passes."*

- **Now (temp server):**
  - `docker compose -p lumedev up` gives HTTPS on `https://lume.localhost:8443` (via tunnel).
  - `/healthz` returns 200. `/readyz` returns 200 with DB + queue OK, and 503 when the DB is stopped.
  - The backup job produces an `age`-encrypted dump in the offsite remote.
  - The restore test restores it into a scratch DB, sanity counts pass, and the result is recorded.
- **Now (container):** `bootstrap-server.sh` runs twice in a disposable `ubuntu:24.04` container without error (idempotency). Steps that need systemd/sshd/ufw are exercised in check mode (`--dry-run` prints actions) in that environment.
- **Later (real server):** full `bootstrap-server.sh` + compose run on the owner's fresh VPS. Phase 0 is only marked complete after this run. Until then it's "accepted on temp".
- **CI:** lint, typecheck, shellcheck and unit/integration tests (real Postgres 17) run green on GitHub Actions. Images build and push to `ghcr.io/kedar2812/lume-v3/*` tagged by git SHA.

## 5. Technical decisions not fixed by the report

- **Package manager:** pnpm 10 via corepack. Node 22 LTS everywhere (`.nvmrc`, `engines`, Docker bases pinned by digest in CI).
- **Language/tooling:** TypeScript 5 strict, ESLint (flat config) + Prettier, Vitest for unit/integration; DB tests against the `lumedev-pgtest` container (see Worker/DB tests below).
- **Migrations:** plain SQL files `packages/db/migrations/NNNN_name.sql`, applied by a small runner (`packages/db/src/migrate.ts`) that records them in `schema_migrations` with a checksum and refuses edited migrations. It runs as `lume_owner` in the one-off `migrate` container. Drizzle is used for the query-builder schema from Phase 1. Phase 0 migrations: extensions (`citext`, `pg_trgm`), roles and grants baseline, `schema_migrations`, `ops_restore_tests` (records restore-test results for System health later).
- **Postgres roles** are created by `infra/postgres/init/00-roles.sh` (first boot) with passwords from env. Grants live in migration `0002_grants.sql` so they are versioned.
- **Health endpoints:** `GET /healthz` (process up, no DB) and `GET /readyz` (DB `select 1` as `lume_app` + pg-boss reachable), both `public: true`. The Phase 1 route-permission boot check gets its hook now: every route must declare `config.permission` or `config.public`, and boot fails otherwise.
- **Worker:** `apps/worker` starts pg-boss as `lume_worker` and registers `ops.backup` (cron `0 */6 * * *`) and `ops.restore-test` (cron `0 4 * * 1`). The worker image itself bundles `postgresql-client-17`, `age` and `rclone` and runs `infra/scripts/backup.sh` / `restore-test.sh` as child processes. There is no sidecar, because that would need the Docker socket, which is root-equivalent. Credentials:
  - dumps: `lume_readonly_backup`
  - restores: `lume_restore` (`CREATEDB` only; it creates and drops its own scratch DB)
  - never a DB superuser
- **Backup encryption:** each dump is encrypted to **two** age recipients: the owner's offline key (disaster recovery) and a server-held *restore-test* key (the only way an automated weekly restore can decrypt). An attacker on the server already has the live DB, so the server key adds no new exposure. A leaked off-site bucket alone stays unreadable.
- **Retention** (7 days of 6-hourly, 4 weekly, 6 monthly) is computed by a pure, unit-tested function in `packages/core` and applied by the worker via `rclone lsf` / `rclone deletefile`.
- **DB tests** use a dedicated Postgres 17 container (`lumedev-pgtest`) with **no published ports** on an internal Docker network, with a fresh database per test file. Testcontainers is not used on the shared host, because it publishes ports on `0.0.0.0`, which Docker exposes past UFW. CI uses the same script.
- **Queue schema:** pg-boss's schema is installed by the `migrate` container as `lume_owner`. The worker starts pg-boss with `migrate: false`.
- **Caddy:** routes `/api/*` and `/webhooks/*` → api:3001, everything else → web:3000. Security headers from report §12.3. Global rate limit via the `caddy-ratelimit` plugin, in a custom Caddy build image.
- **Env validation:** `packages/config` with Zod. It fails fast listing every missing/invalid variable and rejects weak secrets (`LUME_MASTER_KEY` < 32 bytes, default-looking passwords).

## 6. Out of scope for Phase 0
Everything in Phase 1+ (auth, RBAC, data model tables), SMTP, real domain/TLS, real off-site storage account, production deployment.
