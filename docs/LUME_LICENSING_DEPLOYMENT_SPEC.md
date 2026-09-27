# LUME — Licensing & Deployment Spec

Addendum to the LUME master project report. Covers product framing, the licence system, per-client deployment, updates, and offboarding.

---

## 0. Product framing — READ FIRST

LUME is a **general-purpose, multi-client lead management product**. It is NOT a custom app for any single client.

- Nupuur Patil's business is the **first customer**, not the product definition. Her setup (Superreply → Google Sheet, Calendly, Google Calendar, her funnel stages, her team) is one configuration of LUME.
- Every client gets their **own isolated instance** (own server, own database, own backend). There is no shared multi-tenant database.
- All instances run the **same codebase and the same Docker image**. Differences between clients live only in configuration (env file + settings stored in the instance database).

### Hard rules for all code
1. **No client-specific code.** No client names, hardcoded funnel stages, hardcoded sheet IDs, or `if client == X` branches anywhere.
2. **Everything client-specific is configurable** via the admin settings UI or the instance `.env`: business name, logo, colours (optional override), funnel stages, custom fields, roles, integrations, WhatsApp templates, timezone, currency.
3. **Integrations are optional modules**, toggled per instance: Google Sheets import, Calendly, Google Calendar, email digest. An instance with all integrations off must work fully.
4. **Seed data and defaults are generic** (e.g. stages: New → Contacted → Qualified → Proposal → Won / Lost). Demo data uses fictional businesses.
5. **No lead data ever leaves the client's server** except to integrations the client has enabled. The licence check sends only the metadata listed in §2.4.
6. **One version line.** No per-client forks or branches. If a client needs something, it becomes a configurable feature for everyone.

---

## 1. System overview

Two separate pieces of software:

| Component | Where it runs | Owner |
|---|---|---|
| **LUME Instance** (frontend + API + Postgres) | Each client's own VPS | Client owns server; Kedar deploys & maintains |
| **LUME Licence Server** (small API + admin panel) | Kedar's infra, at `license.lumecrm.in` | Kedar |

Client instances are reached at a subdomain of the LUME domain: `<client-slug>.lumecrm.in` (DNS A record → client's server IP). Custom client domains are optional later.

---

## 2. Licence system

### 2.1 Licence types
- `subscription` — monthly or annual, has `paid_until` date. Default for new clients.
- `perpetual` — one-time licence, no expiry (used for Nupuur's instance). Still checks in, but never expires for non-payment.
- `trial` — fixed end date, for demos.

### 2.2 Licence states (as seen by the instance)
| State | Trigger | Behaviour |
|---|---|---|
| `active` | Valid, paid | Full access |
| `grace` | Payment overdue ≤ 7 days, OR licence server unreachable ≤ 7 days | Full access + admin-only banner |
| `read_only` | Overdue > 7 days, OR unreachable > 7 days | Users can view and **export**; all writes blocked (API returns 403 `LICENSE_READ_ONLY`) |
| `suspended` | Cancelled / revoked by Kedar | Lock screen for all users; **admin can still export all data** |

Export must work in every state. Clients always get their data out.

### 2.3 How the check works
- Each instance has `LUME_LICENSE_KEY` and `LUME_INSTANCE_ID` in its `.env`.
- On API startup and every **6 hours**, the instance calls `POST https://license.lumecrm.in/v1/check`.
- The licence server responds with a **signed token** (Ed25519) containing: `instance_id`, `state`, `license_type`, `valid_until` (token expiry, ~8 days out), `issued_at`.
- The instance verifies the signature with the **public key bundled in the image**. The private key exists only on the licence server.
- The last valid token is cached in the instance DB. If the server is unreachable, the instance keeps using the cached token until its `valid_until`, then drops to `grace` and then `read_only` per §2.2.
- Enforcement lives in **backend middleware**, not only in the frontend.
- Tampering with the clock or DB should not bypass checks trivially: compare against token `issued_at` and refuse tokens issued in the future.

### 2.4 Data sent to the licence server (only this)
`instance_id`, `license_key`, `app_version`, `active_user_count`, `lead_count` (number only), `server_time`. **Never** lead names, phone numbers, or any lead content.

### 2.5 Licence server — features
- API: `POST /v1/check`, admin CRUD.
- Admin panel (Kedar only, strong auth + 2FA):
  - Clients list: name, slug, instance ID, licence type, state, paid_until, last check-in, app version, server IP.
  - Actions: create licence, extend `paid_until`, mark paid, suspend, revoke, rotate key.
  - Alert list: instances not checked in for > 24h, payments due in 5 days, instances on outdated versions.
- Stack: small separate service (same language as LUME API), own Postgres/SQLite, hosted on Kedar's VPS.
- Payments are marked manually at first (UPI/bank). Payment gateway integration is a later phase.

---

## 3. Deployment model

### 3.1 Client server requirements
- Ubuntu 24.04 LTS, minimum 2 vCPU / 8 GB RAM (e.g. Hostinger KVM 2 or equivalent)
- Client purchases the server; Kedar gets a **non-root sudo user `lume-deploy` with SSH key auth**. Root password is not used.

### 3.2 What runs on the client server
Docker Compose stack:
- `lume-web` (frontend)
- `lume-api` (backend)
- `postgres`
- `caddy` (reverse proxy, automatic HTTPS)
- `backup` (nightly job, see §3.5)

### 3.3 Rules
- **No source code on client servers.** Only prebuilt images pulled from a private registry (e.g. GitHub Container Registry) with a read-only pull token.
- Images are tagged by version (`lume-api:1.4.2`). `latest` is never used in production.
- Per-client differences live only in `/opt/lume/.env` and the instance DB.
- Frontend builds: minified, no source maps in production.

### 3.4 Provisioning script (`scripts/provision.sh`)
Run once per new client. Idempotent. Steps:
1. Create `lume-deploy` user, install SSH key, disable password auth.
2. Install Docker + Compose, enable `ufw` (allow 22, 80, 443 only), enable unattended security updates.
3. Create `/opt/lume/` with `docker-compose.yml` and generated `.env` (from `clients/<slug>.env` template).
4. Log in to registry, pull pinned image versions, start the stack.
5. Run DB migrations, create the first admin user, register instance with licence server.
6. Health check `https://<slug>.lumecrm.in/api/health` returns 200.

DNS (`<slug>.lumecrm.in` A record) is added manually before step 4.

### 3.5 Backups
- Nightly `pg_dump`, compressed, 14-day retention locally.
- Optional off-server copy to an S3-compatible bucket if configured in `.env` (`BACKUP_S3_*`).
- `scripts/restore.sh` documented and tested.
- Backup status (last success time) shown in the instance admin settings.

---

## 4. Updates across all clients

- **Client inventory file**: `deploy/clients.yml` listing slug, server IP, SSH user, current version, licence type.
- **`scripts/update.sh <version> [slug|all]`**:
  1. For each target: SSH in, back up the DB first, pull new images, run migrations, restart, run health check.
  2. On failed health check: roll back to the previous image tag and restore the pre-update backup if migrations ran.
  3. Update `clients.yml` with the new version and print a summary table.
- Migrations must be **forward-compatible and non-destructive** (no dropping columns in the same release they stop being used).
- Changelog maintained in `CHANGELOG.md`; version shown in instance admin footer.

---

## 5. Onboarding a new client (checklist)
1. Create licence on licence server → get `license_key` + `instance_id`.
2. Client buys VPS, adds Kedar's SSH key / creates `lume-deploy` user.
3. Add DNS record `<slug>.lumecrm.in`.
4. Create `clients/<slug>.env`, run `provision.sh`.
5. In admin settings: business name, logo, funnel stages, fields, roles, users, integrations, WhatsApp templates.
6. Optional: import existing leads (CSV or Google Sheet).
7. Add client to `clients.yml`.

## 6. Offboarding a cancelled client
1. Set licence to `suspended` on licence server.
2. Generate a **full data export** (leads, notes, activity history, users) as CSV + Excel zip; hand it to the client and get written confirmation of receipt.
3. Run `scripts/decommission.sh <slug>`: stop containers, remove images, volumes, `/opt/lume`, and local backups.
4. Remove DNS record, remove `lume-deploy` user and SSH key, revoke registry token for that instance.
5. Mark client `decommissioned` in licence server and `clients.yml`.

---

## 7. Security notes
- Licence signing private key: only on licence server, never in repo or images.
- Registry pull tokens: read-only, one per client, revocable.
- All secrets in `.env` with `chmod 600`; `.env` never committed.
- Instance admin can see licence state and data export, but not licence internals.

## 8. Contract points (not code — for Kedar's agreements)
- Client receives usage rights only; no copying, modifying, or reverse engineering.
- Client owns its lead data; full export provided on cancellation before deletion.
- Instance is removed from client's server on cancellation.
- Server purchase, renewal, and cost are the client's; setup and updates are Kedar's.
- Data processing clause (client's leads are personal data under India's DPDP Act).

---

## 9. Acceptance criteria
- [ ] Codebase contains no client-specific names, IDs, or branches (grep check in CI for known client names).
- [ ] Fresh instance with all integrations off works end to end.
- [ ] Instance respects all four licence states; writes blocked in `read_only`; export works in every state.
- [ ] Instance survives licence server downtime for 7 days without disruption.
- [ ] Forged or modified licence tokens are rejected.
- [ ] `provision.sh` brings up a new client on a clean Ubuntu VPS with no manual steps besides DNS.
- [ ] `update.sh all` updates multiple instances and rolls back a failed one automatically.
- [ ] `decommission.sh` leaves no LUME files, containers, or data on the server.
- [ ] Licence check payload contains no lead content.
