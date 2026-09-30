# Licensing L-C — Releases and the fleet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Native). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A LUME release is a set of versioned, release-marked images; one command brings up a client, one updates the fleet (backing up first and rolling back on failure), one removes a client and leaves nothing behind — all tested without real servers.

**Architecture:**
- **Releases.** The version is the root `package.json`'s. A `vX.Y.Z` tag runs `.github/workflows/release.yml`: it builds api, web, worker and caddy with `LUME_RELEASE=1` (each image bakes `/app/release.json`) and `LUME_VERSION`, tags them `X.Y.Z` (never `latest`) and pushes them to GHCR. A release image refuses to start with no licence keys.
- **The fleet.** `deploy/clients.yml` is the inventory: no secrets. Each client's secrets live in `deploy/clients/<slug>.env` (gitignored, made by `provision.sh` on first run).
- **The scripts** are bash that run each remote step over `ssh`, with `scripts/fleet/lib.sh` shared. They read and write the inventory through `scripts/fleet/inventory.mjs`, a small reader and writer for its fixed shape.
- **Tests.** A vitest harness (`scripts/fleet/fleet.test.ts`) runs the scripts with stub `ssh`, `scp`, `docker` and `curl` first on the PATH. The stubs record every call and answer from a scenario file, so a failed health check or a missing licence can be staged. It is part of the root vitest workspace. shellcheck covers the scripts in CI.

**Tech Stack:** bash, Node 22, vitest, GitHub Actions, GHCR, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-30-licensing-deployment-design.md` (§5, and the source spec `docs/LUME_LICENSING_DEPLOYMENT_SPEC.md` §3–§6, §9).

## Global Constraints

- **Never `latest` in production.** Every image is pinned to its version.
- **No source code on a client's server.** Only images, the compose file, the Postgres config files, and `.env` (mode 600).
- **Secrets never enter git:** `deploy/clients/*.env` is gitignored; the scripts never echo a secret.
- **Every remote step checks before it acts** (idempotent), and has `--dry-run`, which prints the steps without calling out.
- **Never run against the build host** (200.97.166.16): the scripts refuse that host.
- **A release build with no licence keys fails at start**, with a message saying so (L-A final review).
- **Migrations stay forward-compatible:** `CHANGELOG.md` records each release, and 0030 widening roles is noted.

## Review Focus

1. **Rollback:** a health check that fails after migrations ran must restore the pre-update backup and go back to the previous tag. A failure before migrations must not restore anything.
2. **`update.sh all`** carries on past one failed client, rolls back only that client, and reports it in the table. The inventory keeps each client's real version.
3. **Decommission guards:** it refuses without `--export-confirmed`, refuses when the licence isn't suspended, and never runs on a host it can't name from the inventory.
4. **Idempotency:** a second `provision.sh` run changes nothing and doesn't regenerate secrets (a new master key would lock every encrypted value).
5. **Release marker:** a release image has `/app/release.json`; a dev build doesn't; and a release with empty keys refuses to start.

---

### Task 1: Versions and release images

**Files:** the root `package.json` (version); `CHANGELOG.md`; `infra/docker/{api,web,worker,caddy}.Dockerfile` (`ARG LUME_RELEASE`, `ARG LUME_VERSION`, bake `/app/release.json` and `LUME_VERSION`); `.github/workflows/release.yml`; `apps/api/src/licence/options.ts` + `main.ts` (refuse to start with no keys in a release); tests.

- [ ] Failing tests:
  - `resolveLicence`/boot refuses a release with no keys, and says why;
  - the Dockerfiles bake the marker only when `LUME_RELEASE=1`;
  - `release.yml` builds the four images, tags `X.Y.Z` from the tag, never `latest`, and pushes to `ghcr.io/<owner>/lume-<name>`;
  - the root version matches `CHANGELOG.md`'s newest entry.
- [ ] RED, implement, GREEN. Commit: `feat(release): versioned, release-marked images`.

### Task 2: The inventory and the fleet library

**Files:** `deploy/clients.yml` (empty fleet, with a commented example); `deploy/clients/.gitkeep`; `.gitignore` (`deploy/clients/*.env`); `scripts/fleet/inventory.mjs` (get, list, set-version; refuses unknown slugs and a malformed file); `scripts/fleet/lib.sh` (`remote`, `dry`, `step`, and refusing the build host); `scripts/fleet/stubs/*` and `scripts/fleet/fleet.test.ts`; root `vitest.config.ts` gains `scripts/fleet`.

- [ ] Failing tests: the inventory round-trips and rejects bad input; `lib.sh` refuses the build host; the stubs record calls in order.
- [ ] RED, implement, GREEN. Commit: `feat(fleet): the client inventory and the test harness`.

### Task 3: provision.sh

**Files:** `scripts/provision.sh`; `deploy/templates/docker-compose.yml` (the production compose, images from GHCR by version); `deploy/templates/client.env` (generated secrets); tests.

- [ ] Failing tests (stubbed):
  - a first run generates secrets once, hardens the host (bootstrap-server.sh), installs Docker, writes `/opt/lume` (600), logs in to GHCR, pulls the pinned version, migrates, starts, waits for health and prints the setup link;
  - a second run changes nothing and keeps the secrets;
  - `--dry-run` calls nothing;
  - a missing DNS answer stops before pulling.
- [ ] RED, implement, GREEN. Commit: `feat(fleet): provision a client`.

### Task 4: update.sh

**Files:** `scripts/update.sh`; tests.

- [ ] Failing tests (stubbed):
  - backup first, then pull, migrate, restart and health; the inventory is updated and a table printed;
  - health fails after migrations: roll back to the previous tag and restore the pre-update backup;
  - health fails with no migrations run: roll back without restoring;
  - `all` carries on past a failure;
  - a backup that fails stops that client before anything changes.
- [ ] RED, implement, GREEN. Commit: `feat(fleet): update the fleet, with a backup first and a rollback`.

### Task 5: decommission.sh, the runbook, the final review

**Files:** `scripts/decommission.sh`; `docs/runbooks/fleet.md` (onboarding, updates, offboarding, the owner's clean-VPS acceptance); tests.

- [ ] Failing tests (stubbed):
  - refuses without `--export-confirmed`;
  - refuses unless the instance's licence token says suspended;
  - removes the stack, images, volumes, `/opt/lume` and backups, and the deploy key;
  - prints the registry token to revoke and the DNS record to remove;
  - marks the client decommissioned in the inventory.
- [ ] RED, implement, GREEN. Commit: `feat(fleet): decommission a client, leaving nothing`.
- [ ] Final whole-branch review (fresh reviewer), fix pass, ledger.

## Rulings (the owner's to overturn)
- C1. The inventory is YAML (as the spec says), read and written by a small Node module for its fixed shape (no YAML dependency, no `yq` on the operator's machine).
- C2. `update.sh` backs up with the worker's own `run-now ops.backup` (encrypted, off-site as configured) and, for rollback, a plain `pg_dump` kept on the server for that update.
- C3. `decommission.sh` reads the licence state from the instance's own stored token (decoding its payload); the licence server isn't asked.
- C4. The real clean-VPS run is the owner's acceptance step (R, spec §5), following `docs/runbooks/fleet.md`.
