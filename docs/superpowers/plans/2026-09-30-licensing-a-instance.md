# Licensing L-A — The instance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Native, as every phase since 3A). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A LUME instance checks its licence with the licence server, knows its state without it for a week, enforces that state in the API, tells people in the web, and always lets its data out.

**Architecture:**
- A signed token (Ed25519) and a pure state function live in `@lume/core`.
- The API checks (at start, every 6 hours, on Check now, and at sign-in when stale), stores the last good token, keeps the state in memory, and enforces it in one hook.
- The web reads the state from `/auth/me` and shows the About card, the banners, the lock screen and the payment reminder.
- A streamed zip export works in every state.

**Tech Stack:** as the app; exceljs (streaming workbook) and archiver (streaming zip) are new in the API.

**Spec:** `docs/superpowers/specs/2026-09-30-licensing-deployment-design.md` (§2, §3, §6, §7).

## Global Constraints

- Build to the FINAL canvas: Main (About card), States (grace, read-only, suspended), PaymentReminder. The apple-design skill applies; both themes; full review copies.
- The check sends only `instanceId, licenseKey, appVersion, activeUserCount, leadCount, serverTime` (the source spec, §2.4).
- Enforcement is in the API. Export works in every state.
- A release image never trusts the environment for its keys or its dev mode.
- Copy speaks as LUME. No client names. The owner's words stand: "LUME is paused"; read-only is the accent blue; the suspended padlock is red.
- The gate: TDD with RED watched, CI read after every push, the live chain.

## Review Focus

1. **Time:** 23h59m against 24h unreachable, 7 days exactly, a clock 5 minutes behind `issuedAt`, `validUntil` passed while the server is still reachable-but-refusing.
2. **Forged tokens:** a payload changed after signing, re-encoded base64, an unknown `kid`, another instance's token, a token signed by a test key in a release build.
3. **The allowlist:** a read-only instance still lets people sign in, run two-step, dismiss the reminder, Check now and export — and nothing else writes, including webhooks and background jobs.
4. **The reminder:** shown to owners and admins only, at every sign-in, closed per session, gone after payment — never to reps.
5. **The export:** unmasked, complete (custom fields, tags, owners, stages), streamed (a big install doesn't hold it all in memory), in every state, audited.

---

### Task 1: The token and the state (core)

**Files:** Create `packages/core/src/licence/{token,state,keys,index}.ts` (+ tests); export from `packages/core/src/index.ts`.

**Interfaces (Produces):**
- `type LicencePayload = { v: 1; kid: string; instanceId: string; state: LicenceStateName; licenseType: "subscription" | "perpetual" | "trial"; issuedAt: string; validUntil: string; paidUntil: string | null; trialEndsAt: string | null; reason: string; notice: { id: string; kind: "payment_due"; dueDate: string | null; note: string } | null }`
- `signLicence(payload, privateKey: KeyObject): string` and `verifyLicence(token, keys: Record<string, Uint8Array | KeyObject>, instanceId): LicencePayload | null`.
- `licenceState({ payload, lastSuccessAt, firstBootAt, now, dev }): LicenceView`, where `LicenceView = { state, reason, graceEndsAt: string | null, licenseType, paidUntil, trialEndsAt, notice, checkedAt, dev }`.
- `LICENCE_KEYS` (production public keys, by `kid`) and `checkBody(...)` (only the §2.4 fields).

- [ ] Failing tests:
  - sign then verify round-trips;
  - each Review Focus 2 case is refused;
  - `licenceState` at every Review Focus 1 boundary;
  - the order of severity;
  - a new install's week;
  - dev mode;
  - `checkBody` has exactly six keys.
- [ ] RED, implement, GREEN. Commit: `feat(core): the licence token and the licence state`.

### Task 2: Checking, storing and saying the state (API)

**Files:**
- Create: migration `0031_licence.sql` (`licence_state`, `sessions.notice_dismissed`, the `data.export` permission for existing admins); `packages/db/src/schema/licence.ts`; `apps/api/src/licence/{client,service,routes}.ts` (+ tests).
- Modify: config (`LUME_LICENSE_KEY`, `LUME_INSTANCE_ID`, `LUME_LICENSE_URL`, `LUME_LICENSE_MODE`, and the baked `LUME_RELEASE`), `app.ts`, `/auth/me`, sign-in, and the API's pg-boss (a `licence.check` cron every 6 hours, and one at start).

**Interfaces:**
- `GET /api/v1/licence` (auth.self) → `LicenceView` (and whether the caller may Check now).
- `POST /api/v1/licence/check` (settings.manage) → `LicenceView`.
- `POST /api/v1/licence/notice/dismiss` (auth.self; owners and admins) → 204.
- `/auth/me` gains `licence: LicenceView & { showNotice: boolean }`.

- [ ] Failing tests:
  - a good answer is stored and changes the state;
  - network down keeps the old token;
  - a bad signature is refused and recorded;
  - 401 keeps the token until it runs out;
  - the body's keys;
  - sign-in checks when stale (and not when fresh), without waiting;
  - the reminder shows for owners and admins only, is dismissed per session, and returns at the next sign-in;
  - a release build ignores dev mode and environment keys.
- [ ] RED, implement, GREEN. Commit: `feat(api): the instance checks its licence and knows its state`.

### Task 3: Enforcement

**Files:** Create `apps/api/src/licence/enforce.ts` (+ tests). Modify the receive (webhooks) routes and every lead-writing job runner (imports, sheets, webhook processing, reminders, escalation, the digest, no-touch).

- [ ] Failing tests:
  - read_only refuses every write with `LICENSE_READ_ONLY`, but allows the allowlist (Review Focus 3);
  - suspended refuses everything with `LICENSE_SUSPENDED` beyond its own allowlist;
  - webhooks refuse;
  - each job skips while locked and runs again once licensed;
  - reads work in read_only.
- [ ] RED, implement, GREEN. Commit: `feat(api): the licence state is enforced in the API, with its allowlist`.

### Task 4: Export all data

**Files:** Create `apps/api/src/export/{service,routes}.ts` (+ tests). Add the `data.export` permission to the catalog and the Admin preset.

- [ ] Failing tests:
  - the zip holds the five CSVs and the workbook;
  - leads are unmasked, with custom fields, tags, owner and stage names;
  - notes, activity, follow-ups and users;
  - it works in every state;
  - it's for `data.export` only;
  - it's audited;
  - it streams (a large fixture's memory stays bounded).
- [ ] RED, implement, GREEN. Commit: `feat(api): export everything, in every licence state`.

### Task 5: The web

**Files:**
- Create `apps/web/src/components/licence/{LicenceCard,LicenceBanner,LockScreen,PaymentReminder,ExportAll}.tsx` (+ tests) and `lib/licence/client.ts`.
- Modify `AppShell` (the banner, lock and reminder), Settings → About (the card), and the toast for 403 licence codes.

- [ ] Failing tests:
  - the About card for each state and type, and Check now's spin then tick (admins only);
  - grace's banner for admins only;
  - read-only's blue bar for everyone, and a refused write said in LUME's words;
  - the lock screen for everyone, with Export all data for admins, ticking through the files;
  - the reminder for owners and admins, "I'll sort it" closing it for the session, and never for reps;
  - reduced motion.
- [ ] RED, implement with the apple-design skill (to the canvas), GREEN. Commit: `feat(web): the licence, as people see it`.

### Task 6: End to end, live, runbook

- **e2e:** `licence.spec.ts` runs against a fake licence server in the e2e stack (a `licence-fake.ts`, like the Google fake, signing with a test key the e2e build is given). It covers:
  - active, then the owner's view of grace;
  - read-only (a write refused, export works);
  - suspended (the lock screen, and the admin exports);
  - the reminder (shown, closed, back at the next sign-in, gone once paid).
  - Screenshots and axe in both themes.
- **The live acceptance** runs once L-B is deployed; see the L-B plan.
- **Runbook:** a "Licensing L-A" section.
- Commit: `test(e2e): the licence, end to end`.

## Rulings (the owner's to overturn)
- R1. Jobs that write or send on a locked instance skip and log; backups, restore tests and retention always run.
- R2. The reminder's "closed for this session" lives on the session row, so every new sign-in shows it again.
- R3. A new install without a successful check has 7 days of grace from first boot.
- R4. Release builds carry `LUME_RELEASE=1` from a Docker build argument; the env can't turn a release image into a dev one.
