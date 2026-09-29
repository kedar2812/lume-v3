# Licensing and deployment — design

Source: `docs/LUME_LICENSING_DEPLOYMENT_SPEC.md` (the owner's addendum; its hard rules and §9 acceptance criteria bind this design). Screens: the approved canvas at https://claude.ai/artifact/PPNJQSEckdpA9YQscAWsUj (FINAL, owner 2026-09-29): build to it.

**Status:**
- The owner approved section L-A (2026-09-29), and every screen on the canvas, including the analytics, prices, bell, themes and the trend rule.
- Sections L-B and L-C, and the rulings marked **(R)**, were decided overnight on 2026-09-30 under the owner's standing authority ("you have full authority to choose the best possible outcomes"). They are the owner's to overturn.

## 1. The split

One spec, three plans, built in order:

| Part | What | Where |
|---|---|---|
| **L-A** | The instance: checks its licence, knows its state, enforces it, tells people, exports everything | `packages/core/src/licence`, `apps/api`, `apps/web` |
| **L-B** | The licence server: `/v1/check`, the admin panel (clients, analytics, prices, payments, reminders, releases) | `apps/licence` (new), its own Postgres |
| **L-C** | Releases and the fleet: versioned images, the client inventory, provision / update / decommission | CI, `deploy/`, `scripts/` |

## 2. The token (shared by L-A and L-B)

- **Signed with Ed25519 (Node's `crypto`).** A token is `base64url(payload JSON) + "." + base64url(signature over that first part)`.
- **The payload:**
  - `v: 1` and `kid`, the signing key's id;
  - `instanceId`, `state` (`active | grace | read_only | suspended`), `licenseType` (`subscription | perpetual | trial`);
  - `issuedAt` and `validUntil` (ISO), with `validUntil = issuedAt + 8 days`;
  - `paidUntil` and `trialEndsAt` (ISO dates or null), and `reason` (`paid | overdue | trial | trial_ended | perpetual | suspended`);
  - `notice`: `{ id, kind: "payment_due", dueDate, note }` or null.
- **Public keys** are compiled into release images in `packages/core/src/licence/keys.ts`, as a map of `kid` to a raw 32-byte public key. A rotation adds a key; release builds never read a key from the environment.
  - **(R)** The production key pair is generated once, on the licence server's host, by `apps/licence/scripts/keygen.mjs`. The private key lands in `/root/lume-licence/secrets/signing.pem` (mode 600) and never enters the repo, an image or a log. The public key is committed.
- **Verification:**
  - the signature is checked against the key its `kid` names, and an unknown `kid` is refused;
  - a malformed or re-encoded payload is refused;
  - the `instanceId` must equal this instance's own.

## 3. L-A — the instance

### 3.1 Configuration
- **`.env` holds three settings:**
  - `LUME_LICENSE_KEY` and `LUME_INSTANCE_ID`, both required in a release build;
  - `LUME_LICENSE_URL`, defaulting to `https://license.lumecrm.in`. Any server can be named, but only tokens signed by LUME's keys count.
- **Development:** a release image is built with `LUME_RELEASE=1` (a Docker build argument baked into the image). Any other build is a development build, where `LUME_LICENSE_MODE=dev` makes the licence always active and says so ("Development licence"). A release image ignores `LUME_LICENSE_MODE`.

### 3.2 Checking
- **A single row, `licence_state`, holds:**
  - the last verified token and its payload;
  - `first_boot_at`, `last_attempt_at`, `last_success_at` and `last_error`.
- **When a check runs:**
  - at API start;
  - every 6 hours (pg-boss cron in the API, `licence.check`);
  - on Check now (Settings → About, admins);
  - at a sign-in, if the last check was more than 15 minutes ago. That check runs in the background; sign-in never waits for it.
- **What is sent** (spec §2.4, only this): `instanceId`, `licenseKey`, `appVersion`, `activeUserCount`, `leadCount` (a number) and `serverTime`. A unit test pins the body's keys.
- **A failed check** (network, 5xx, a bad signature) keeps the previous token and records `last_error`. A refused key (401) keeps the token too; it can only run out.

### 3.3 The state (a pure function in core, `licenceState`)
Inputs: the verified payload (or null), `lastSuccessAt`, `firstBootAt` and `now`. The severity order is active < grace < read_only < suspended. The worst of these wins:
- the token's own state (suspended stays suspended);
- **the clock:** `now` more than 5 minutes before the token's `issuedAt` gives read_only (reason `clock`);
- **an expired token:** `now` past `validUntil` gives read_only (reason `expired`);
- **the licence server unreachable** (measured from `lastSuccessAt`, or from `firstBootAt` if it has never answered):
  - under 24 hours: no change;
  - 24 hours to 7 days: grace (reason `unreachable`);
  - over 7 days: read_only;
- **no token yet** (a new install): grace (reason `not_checked`) for up to 7 days after first boot, then read_only.

The result carries `state`, `reason`, `graceEndsAt`, `licenseType`, `paidUntil`, `notice` and `checkedAt`.

### 3.4 Enforcement (backend, not only the web)
- **The API keeps the state in memory**, refreshed from the database at most every 30 seconds and at once after a check.
- **read_only:** every write (POST, PUT, PATCH, DELETE) answers 403 `LICENSE_READ_ONLY`, except:
  - sign-in, sign-out and two-step (`/api/v1/auth/*`);
  - licence Check now, and dismissing a notice;
  - the data export.
- **suspended:** everything answers 403 `LICENSE_SUSPENDED`, except:
  - `/api/v1/auth/*` (so an admin can sign in);
  - `GET /api/v1/licence`, and dismissing a notice;
  - the export (admins).
- **Inbound webhooks** answer 403 with the same codes while read_only or suspended.
- **API jobs** that write lead data or send on its behalf skip their work while read_only or suspended, and log that they did:
  - imports, sheet syncs and inbound webhook processing;
  - reminders, escalations, the morning email and no-touch.
- **(R)** The worker's ops (backups, restore tests, retention) always run: a locked instance still keeps its data safe.

### 3.5 What people see (canvas: Main, States, PaymentReminder)
- **Settings → About, the licence card:**
  - a ring drawn round the mark;
  - the state in words, the licence type, "Paid until …" (or "Never expires" or "Trial ends …"), and "Last checked …";
  - Check now (admins): it spins, then shows a green tick.
  - Everyone sees the card; only admins get Check now.
- **grace:** an amber banner for admins only, saying why and when grace ends.
- **read_only:** a bar in the accent blue #2A5BFF, white text, for everyone. Controls stay visible; writes come back 403 and LUME says why in its toast.
- **suspended:** a blurred lock screen.
  - A red (#E5484D) padlock tile, and the heading "LUME is paused".
  - Admins get Export all data, which ticks through the files, then downloads the zip.
- **The payment reminder:** a modal for owners and admins (not reps) at every sign-in while a notice is on the token.
  - "I'll sort it" closes it for this session (stored on the session row); "Contact about payment" is the second action.
  - Marking the payment paid on the licence server clears the notice at the next check.
- **The licence status comes with `/api/v1/auth/me`**, so nothing flashes. The web looks again once, a few seconds after sign-in, to catch the background check.

### 3.6 Export all data
- **Who:** the permission `data.export` (Admin preset; existing admins through the migration).
- **Where:** `GET /api/v1/export` streams a zip, in every licence state.
- **What's in it:**
  - `leads.csv` (every core and custom field, stage, owner, tags, unmasked), `notes.csv`, `activity.csv`, `follow-ups.csv` and `users.csv`;
  - `LUME-export.xlsx`, one sheet each, written with exceljs's streaming writer.
- **Audited** as `data.export`.

## 4. L-B — the licence server (apps/licence)

### 4.1 Shape
- **One Next.js app:**
  - route handlers for `/v1/check` and the admin API;
  - the admin panel's pages;
  - its own Postgres (drizzle schema and SQL migrations in `apps/licence/migrations`, run by `@lume/db`'s `migrate`).
- **It reuses** @lume/core's argon2 hashing and TOTP, and the trend rule and money helpers written for it.
- **Its own image:** `infra/docker/licence.Dockerfile`, never part of a client image.
- **(R) Deployed on the owner's host** (200.97.166.16) as its own Compose project (`/root/lume-licence`):
  - the app is bound to 127.0.0.1:8480, with its own `postgres:17`;
  - the public side (an nginx server block for `license.lumecrm.in`, and its certificate) is a runbook step for the owner. It touches the host's existing nginx, which serves another client's site, so it isn't done unattended.

### 4.2 Data
- **admins:** email, argon2 hash, TOTP secret (encrypted with the app's master key), sessions.
- **clients:**
  - name, slug (unique; the subdomain), country (ISO 3166-1 alpha-2), region (an Indian state, for India only), city;
  - source ("How they found LUME": Referrals, Demo site, Website, Instagram, Other);
  - `created_at`, `decommissioned_at`.
- **licences** (one per client):
  - `instance_id` (`LUME-XXXX-XXXX`), the key's SHA-256 hash and last four characters;
  - type, `paid_until`, `trial_ends`, `suspended_at`, `created_at`.
- **prices:** client, currency, amount (numeric), `period_months` (1, 3 or 12; 0 means one-time), `effective_from`. A change adds a row, which is what powers "Price up" and "Price down".
- **payments:** amount, currency, `rate_to_inr` on the day paid, amount in INR, `paid_at`, the new `paid_until`, note.
- **check_ins:** at, IP, app version, active users, lead count, server time, the state returned. Kept 180 days.
- **notices:** payment reminders, with note, `created_at` and `cleared_at`.
- **fx_rates:** date, currency, rate to INR.
- **events:** a client's history ("Moved to grace", "Updated to 1.4.2", "Paid until …").
- **settings:** list price (INR a month), latest version, alert thresholds.
- **alert_dismissals:** alert id plus the condition's fingerprint. A dismissed alert comes back if its condition changes.

### 4.3 `/v1/check`
- **The request:**
  - the body is exactly the §2.4 fields, validated strictly;
  - rate-limited per instance (60 an hour) and per IP.
- **The key** is compared as a SHA-256 hash, in constant time. Unknown, or wrong, answers 401 with nothing more.
- **The state is computed on the server:**
  - suspended, or decommissioned: suspended;
  - perpetual: active;
  - trial: active until `trial_ends`, then read_only (`trial_ended`);
  - subscription: active while `paid_until` is today or later, grace up to 7 days after it (`overdue`), then read_only.
- **Recording:** the check-in is recorded; version changes and state changes become events.
- **The answer** is a signed token (§2) carrying any open notice.

### 4.4 The admin panel (canvas: AdminSignIn, AdminClients, AdminAnalytics, AdminClient)
- **Sign-in:** a dark two-step sign-in (password, then six digits).
  - The first admin is created with `pnpm --filter @lume/licence admin:create`.
  - Sessions are httpOnly, Secure and SameSite=Strict, with double-submit CSRF on every write, and every sign-in is logged.
- **Clients:**
  - state tiles as filters, and a Monthly revenue tile linking to Analytics;
  - search;
  - a table with the flag, "city, region · slug", plan and price (native, with ≈ INR), state pill, paid until, last check-in (with a pulse) and version (with an "update" badge);
  - the bell, and New licence.
- **New licence** is a side sheet:
  - business name, country (flag), state (India only) or city;
  - plan (Subscription, Trial, One-time), then currency, amount and period;
  - a live "≈ ₹… a month in your analytics" line, and how that compares with the list price;
  - how they found LUME.
  - Creating it shows the key once.
- **One client's page:**
  - the check-in strip for 14 days (one bar per 6-hour slot);
  - the installation: instance, version, server IP, people, lead count, last check-in;
  - history;
  - Plan and price (Change: currency switches convert the amount at today's rate);
  - Payment: Mark paid, Extend (+1 month, +3 months, +1 year), and Send payment reminder (an optional note; "Reminder on", and Stop);
  - Licence key (Rotate: the new key typed out once, Copy);
  - Pause this LUME (inline confirm).
- **Analytics** exactly as the canvas, over the real data:
  - MRR, yearly run rate, paying clients, average monthly growth (3M, 6M, 12M);
  - the revenue chart with hover;
  - "What moved it";
  - average per client, lifetime value, clients lost, trial to paid;
  - countries (All or New) with flags, and India by state;
  - revenue by currency;
  - sources, and the price spread against the list price;
  - "Ideas to grow".
  - Every change goes through the one trend rule (§4.5).
- **Releases:** the latest version (set in Settings, and read from the newest check-ins), and which clients are on which version.
- **Payments:** every payment, native and INR, newest first.
- **Settings:** the list price, the latest version, and the admin's own password and two-step.
- **The bell ("Needs a look"):**
  - no check-in for over 24 hours;
  - payments late, or due within 5 days;
  - trials ending within 15 days;
  - clients on an older version.
  - Items hide one at a time or all at once, and an "All clear" state shows when none are left.
- **Light and dark** (Porcelain and Carbon), switched at the foot of the sidebar and remembered. The one accent blue, #2A5BFF, is the same in both.

### 4.5 The trend rule (owner: "robust when we build it")
`trend(now, before, { kind: pct | pts | abs, good: up | down })`:
- **The arrow** follows the direction of the change; **the colour** follows whether that direction is good for this number. Fewer clients lost gets a green arrow pointing down.
- **The decision is made on the rounded, shown number:** anything that rounds to zero is grey "No change", with a flat line.
- **Every number carries its own + or −** (U+2212); colour is never the only signal.
- **Nothing to compare with** (a last month of 0) gives "New", never an infinite percentage.
- **The arrows are jagged, "trending" lines.**
- **The Monthly growth card** is a green gradient when growth is above zero and red when it's below (with "−"), plain when flat, and glows like the blue revenue card.

### 4.6 Money
- **MRR** is in INR:
  - a yearly price counts a twelfth a month, and a quarterly price a third;
  - one-time prices and trials aren't MRR.
- **Which rate:** the trend uses today's rates, so growth isn't exchange-rate noise. A payment keeps the rate of the day it was marked paid.
- **Rates** are fetched once a day from open.er-api.com (free; no key; includes AED and INR) and stored. If a fetch fails, the last rates stand and the page says how old they are.

## 5. L-C — releases and the fleet

- **Versions:**
  - the version lives in the root `package.json`, with `CHANGELOG.md` beside it;
  - tagging `vX.Y.Z` makes CI build every image with `LUME_RELEASE=1`, tag it `X.Y.Z` (never `latest`), and publish to GHCR;
  - the version shows in Settings → About.
- **`deploy/clients.yml`:** slug, host, SSH user, version, licence type and instance ID. No secrets: those stay in `deploy/clients/<slug>.env`, which is gitignored.
- **`scripts/provision.sh <slug>`** is idempotent, and checks each step before it takes it:
  1. harden the host (the existing `bootstrap-server.sh`: user `lume-deploy`, SSH key, ufw 22/80/443, unattended upgrades);
  2. install Docker;
  3. write `/opt/lume/{docker-compose.yml,.env}` (mode 600);
  4. log in to GHCR with the client's own read-only token;
  5. pull the pinned version, migrate and start;
  6. wait for `https://<slug>.lumecrm.in/api/v1/health`;
  7. print the setup link.
  - The first check registers the instance with the licence server.
- **`scripts/update.sh <version> <slug|all>`:**
  1. back up first (the existing encrypted backup, run now);
  2. pull, migrate, restart, and check health;
  3. if health fails: go back to the previous tag, and restore the pre-update backup if the migrations ran;
  4. update `clients.yml` and print a table.
- **`scripts/decommission.sh <slug>`:**
  - refuses unless the licence is suspended and an export was confirmed (`--export-confirmed`);
  - stops the stack, removes containers, images, volumes, `/opt/lume` and local backups;
  - removes the deploy user's key, and prints the registry token to revoke and the DNS record to remove.
- **Tested without real servers:** scripts are exercised against stubbed `ssh`, `docker` and `curl` on the PATH (a vitest harness running bash), plus `--dry-run` modes and shellcheck.
  - **(R)** A real clean-VPS run is the owner's acceptance step, with a runbook.

## 6. Security
- **Keys:** the private signing key exists only on the licence server's host; licence keys are stored as hashes, and shown once.
- **Brute force:** the admin panel uses argon2 and TOTP, with rate-limited sign-in, one admin, and HTTPS only in production.
- **No lead content** ever leaves an instance through the check: a test pins the body.
- **Enforcement** is in the API; the web only explains it.

## 7. Testing
- **Core:**
  - token sign and verify: tampered, re-encoded, unknown `kid` and a wrong instance;
  - `licenceState` across every boundary (23:59h and 24h, 7 days, the clock 5 minutes behind, expiry, no token);
  - `trend` (rounding to zero, New, good-when-down, the signs).
- **API:**
  - each state's enforcement, and its allowlist;
  - the check body's exact keys;
  - sign-in triggering a check;
  - notice dismissal per session;
  - the export's contents (unmasked) in every state;
  - jobs skipped while locked.
- **Licence server:**
  - `/v1/check`: state by type and dates, bad keys, rate limits;
  - admin auth (password, TOTP, CSRF, sessions);
  - every action (create, price change, mark paid with the rate, extend, remind and clear, rotate, suspend);
  - the analytics numbers against the canvas's fixture data, and the alerts.
- **Web and e2e:**
  - every licence screen in both themes, with axe and full review copies;
  - an end-to-end run against a real licence server in the e2e stack (suspend, and the lock screen; mark paid, and it clears).
- **Scripts:** the stubbed harness, and dry runs.

## 8. Out of scope
Payment gateways, custom client domains, automatic DNS, and multi-admin licence servers.
