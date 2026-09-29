# Licensing L-B — The licence server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Native). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `license.lumecrm.in`: the check every LUME instance makes, and the owner's admin panel (clients, prices in any currency, payments, reminders, keys, suspension, analytics in INR, the bell, releases) — built to the FINAL canvas, in both themes.

**Architecture:**
- A new Next.js app, `apps/licence`: route handlers for `/v1/check` and `/api/*` (admin), and server components for the panel.
- Its own Postgres (drizzle schema and SQL migrations, run by `@lume/db`'s `migrate`).
- It signs tokens with the private key from a secrets file.
- Money and the trend rule are pure modules with their own tests.
- Its own image and Compose project, deployed on the owner's host behind 127.0.0.1.

**Tech Stack:** Next.js, drizzle, pg, @lume/core (tokens, argon2, TOTP), Motion; the flag-icons SVGs (MIT) in `public/flags`.

**Spec:** `docs/superpowers/specs/2026-09-30-licensing-deployment-design.md` (§2, §4, §6, §7).

## Global Constraints

- **The canvas is the build reference** (read each screen with the Artifact tool, then build it).
  - The screens: AdminSignIn, AdminClients, AdminAnalytics, AdminClient.
  - What they must carry: Porcelain and Carbon, the one blue #2A5BFF, the jagged trend arrows, the owner's trend rule (exactly), the bell, the flags, and money in any currency with KPIs in INR.
- **One admin.** Argon2 and TOTP; httpOnly, Secure, SameSite=Strict sessions; CSRF on every write; rate-limited sign-in; every sign-in logged.
- **The check:** strict body validation, hashed keys (constant-time), rate-limited, and a signed answer.
- **Never** touch the host's nginx or other sites unattended. Deploy on 127.0.0.1 only; the public side is the owner's runbook step.
- The private signing key lives only in `/root/lume-licence/secrets/signing.pem` (mode 600).
- The gate: TDD with RED watched, CI read after every push, and a live acceptance run against the deployed server.

## Review Focus

1. **The trend rule at its edges:** a change that rounds to 0.0, last month 0 ("New"), clients lost going down (green, pointing down), negative MRR growth colouring the Monthly growth card red, with "−".
2. **Money:**
   - a yearly or quarterly price as monthly;
   - one-time prices and trials not counted as MRR;
   - a currency switch converting at today's rate;
   - a payment keeping its own day's rate;
   - rates missing: say so, don't invent them.
3. **State by date:** paid until yesterday (grace), 7 days later (grace), 8 days (read-only); a trial's last day; perpetual; suspended beats everything.
4. **Auth:** a replayed TOTP within its window is refused the second time; a wrong password or code doesn't say which; CSRF on every write; a stolen session cookie without its CSRF token can't write.
5. **Alerts:** a dismissed alert comes back when its condition changes (a new late payment, a newer version).

---

### Task 1: The app, its database and the check

**Files:**
- `apps/licence/{package.json,next.config.ts,tsconfig.json}`;
- `src/db/{schema.ts,client.ts}` and `migrations/0001_licence.sql`;
- `src/lib/{state.ts,keys.ts}` and `src/app/v1/check/route.ts`;
- `scripts/{keygen.mjs,migrate.mjs,admin-create.mjs}`;
- tests with a real Postgres (the repo's test-db helper).

- [ ] Failing tests:
  - state by type and date (Review Focus 3);
  - `/v1/check` answers a signed token that `@lume/core` verifies;
  - an unknown or wrong key gets 401, and says nothing more;
  - the body is strict (an extra field is refused);
  - a check-in is recorded, and a version change is an event;
  - an open reminder rides in the token;
  - rate limits;
  - keygen writes a 600-mode private key and prints the public one.
- [ ] RED, implement, GREEN. Commit: `feat(licence): the licence server's database and /v1/check`.

### Task 2: The admin: sign-in and the API

**Files:** `src/lib/{auth,session,csrf,money,fx,alerts,analytics,trend}.ts`, `src/app/api/**/route.ts` (+ tests).

**The admin API:**
- clients: list, create (the key shown once), get, update;
- price change (with conversion), mark paid, extend, reminder on and off;
- rotate key, suspend and resume;
- payments, analytics, alerts (dismiss one or all);
- settings (list price, latest version, password, two-step);
- sign-in, the two-step code, sign-out.

- [ ] Failing tests:
  - Review Focus 4;
  - each action's effect and event;
  - money (Review Focus 2);
  - FX fetch, store and fallback;
  - analytics against the canvas's fixture data (MRR, ARR, growth, churn, LTV, ARPA, trial to paid, what moved it, countries and states, currencies, sources, price spread, the ideas);
  - alerts and dismissals (Review Focus 5);
  - the trend rule (Review Focus 1).
- [ ] RED, implement, GREEN. Commit: `feat(licence): the admin API — clients, money, reminders, keys, analytics`.

### Task 3: The panel

**Files:** the pages and components for sign-in, Clients (with the New licence sheet), one client, Analytics, Releases, Payments and Settings; the shell (sidebar, theme switch, bell); styles (Porcelain and Carbon tokens); flags.

- [ ] Failing tests (web unit):
  - the sign-in's two steps;
  - the Clients tiles, search, and the table (flags, prices);
  - New licence's live INR line and the key shown once;
  - a client's actions (inline Suspend confirm, rotate shown once, reminder on and off, price change converting);
  - the analytics cards' tones and arrows, from the trend rule;
  - the bell (count, hide, hide all, All clear);
  - the theme switch remembered.
- [ ] RED, implement with the apple-design skill (to the canvas), GREEN. Commit: `feat(licence): the admin panel, as designed`.

### Task 4: Image, deploy and acceptance

**Files:** `infra/docker/licence.Dockerfile`; `infra/licence/docker-compose.yml`; `docs/runbooks/licence-server.md` (deploy, the nginx server block and certificate for the owner, backups of the licence database); an e2e spec for the panel; `apps/web/e2e-live/acceptance-licence.mjs`.

- [ ] Deploy on the host as its own Compose project on 127.0.0.1:8480, with the key generated there.
- [ ] A live acceptance run against it, through an SSH tunnel:
  - sign in with two steps;
  - create a client, and a dev instance of LUME checks in and turns active;
  - mark paid;
  - send a reminder: the instance's admin sees it at sign-in;
  - suspend: the instance locks, and the admin exports;
  - analytics show the client.
  - Screenshots of every screen, both themes.
- [ ] Commit: `feat(licence): its image, its deploy, and a live run`.

## Rulings (the owner's to overturn)
- R1. The public side (nginx, the certificate) is left as a runbook step, because it edits a live client's host.
- R2. Exchange rates come from open.er-api.com once a day (free; no key; has AED and INR); the last good rates stand when it's down.
- R3. Check-ins are kept 180 days; events, payments and prices forever.
- R4. One admin account; a second is out of scope.
