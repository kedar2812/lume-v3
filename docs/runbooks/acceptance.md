# Phase 0 acceptance evidence

**Date:** 2026-09-21 · **Branch:** `phase-0a` · **Commit tested:** `47d1694` (plus the fixes committed with this file)
**Host:** temporary build host `lumedev` (Ubuntu 24.04.4, 2 vCPU / 7.8 GB, Docker 29.6.1, Compose 5.3.1), a shared client server under the isolation rules in the Phase 0 spec §2.

Report criterion (§17 Phase 0): *`docker compose up` on a fresh Ubuntu VPS yields HTTPS, health checks pass, a backup is created, and the restore test passes.*

| Check | Result |
|---|---|
| HTTPS via Caddy (`tls internal`, `lume.localhost:8443`, bound to 127.0.0.1 only) | ✅ |
| Security headers (HSTS, nosniff, nonce CSP, frame-ancestors none, no Server header) | ✅ |
| `/healthz` 200 · `/readyz` 200 with database + queue ok | ✅ |
| `/readyz` 503 while the DB is stopped, 200 after restart | ✅ |
| Migrations 0001–0004 applied as `lume_owner` | ✅ |
| Backup created (pg_dump → age, 2 recipients → rclone offsite) | ✅ 40,843 bytes |
| Automated restore test (scratch DB as `lume_restore`, sanity counts) | ✅ 10 tables, 4 migrations |
| Owner's offline key decrypts the backup (key never written on the server) | ✅ |
| Nothing LUME listens on a public interface | ✅ only 127.0.0.1:8443 / :8080 |
| Unit + integration tests against real Postgres 17 | ✅ 41 / 41 |
| `bootstrap-server.sh --dry-run` twice in a disposable ubuntu:24.04 container, identical output | ✅ |
| CI run on GitHub Actions | see below |

## Findings fixed during acceptance
- The offsite volume was created root-owned while the worker runs as `node`, so the backup failed with *permission denied*. The worker image now pre-creates `/var/lib/lume/offsite` owned by `node`.
- A failed restore test with no backup recorded an empty backup name. It now records `(none)`.
- The restore runbook assumed `age`/`rclone` on the host. It now runs them through the worker image.
- **Scheduled jobs would never have fired** (found via the CI Postgres log). pg-boss creates its internal cron queue `__pgboss__send-it` at worker start but swallows the permission error, and `lume_worker` rightly has no schema rights. The migrate step now creates it as `lume_owner`, and tests assert it exists. Verified live: with `ops.restore-test` temporarily set to `* * * * *`, a cron-triggered run recorded `3 | 2026-09-21 16:15:47 | lume-20260921T1553Z.dump.age | t | {"tables": 10, "migrations": 4}`. The schedule was then restored to `0 4 * * 1`.
- CI's runner had pg_dump 16 first on the PATH. CI now prepends the Postgres 17 client (the worker image only ships 17).

## Captured output
```
$ scripts/dev.sh remote bash infra/scripts/smoke.sh
  ok  GET /healthz 200
  ok  GET /readyz 200 {"status":"ok","checks":{"database":"ok","queue":"ok"}}
  ok  header strict-transport-security: max-age=63072000
  ok  header x-content-type-options: nosniff
  ok  header content-security-policy: default-src 'self'
  ok  header frame-ancestors 'none'
  ok  no Server header
  ok  web page renders
  ok  unknown API route 404
smoke passed
$ scripts/dev.sh compose exec -T worker node dist/main.js run-now ops.backup
{"level":30,"pid":23,"name":"lume-20260921T1553Z.dump.age","bytes":40843,"deleted":[],"msg":"backup complete"}
$ scripts/dev.sh compose exec -T worker node dist/main.js run-now ops.restore-test
{"level":30,"pid":64,"msg":"restore test passed"}
$ scripts/dev.sh compose exec -T -u postgres db psql -U postgres -d lume -Atc SELECT backup_name, ok, details FROM ops_restore_tests ORDER BY id
|f|{"error": "no backups found"}
lume-20260921T1553Z.dump.age|t|{"tables": 10, "migrations": 4}
$ scripts/dev.sh compose exec -T worker ls -l /var/lib/lume/offsite
total 40
-rw-r--r-- 1 node node 40843 Sep 21 15:53 lume-20260921T1553Z.dump.age
$ scripts/dev.sh compose stop db
 Container lumedev-db-1 Stopping 
 Container lumedev-db-1 Stopped 
$ ssh lumedev curl -sk --resolve lume.localhost:8443:127.0.0.1 -w '  -> HTTP %{http_code}\n' https://lume.localhost:8443/readyz
{"status":"unavailable","checks":{"database":"fail","queue":"fail"}}  -> HTTP 503
$ scripts/dev.sh compose start db
 Container lumedev-db-1 Starting 
 Container lumedev-db-1 Started 
$ ssh lumedev curl -sk --resolve lume.localhost:8443:127.0.0.1 -w '  -> HTTP %{http_code}\n' https://lume.localhost:8443/readyz
{"status":"ok","checks":{"database":"ok","queue":"ok"}}  -> HTTP 200
$ decrypt lume-20260921T1553Z.dump.age with the owner's offline key (key streamed over SSH stdin, never written on the server)
;
; Archive created at 2026-09-21 15:53:11 UTC
;     dbname: lume
;     TOC Entries: 87
;     Compression: gzip
;     Dump Version: 1.16-0
;     Format: CUSTOM
;     Integer: 4 bytes
```

The first `ops_restore_tests` row (`ok = f`, "no backups found") is the genuine failed attempt from before the volume-ownership fix, which also proves failures are recorded.

## CI
- Green: https://github.com/kedar2812/lume-v3/actions/runs/35624483435 (commit `846b6f0`): lint, typecheck, `pnpm audit`, shellcheck, 41/41 tests against Postgres 17, bootstrap dry-run ×2 identical. Image build + GHCR push runs on `main` after merge.

**Status: accepted on temp build host. Final acceptance pending a fresh-VPS run on the production server (spec §4).**

---

# Phase 1A — Identity & access (2026-09-22)

Run on the temp build host (`lumedev`), fresh identity data, through Caddy exactly as a browser does:

```bash
scripts/dev.sh up                    # API image now carries the native Argon2 module; Mailpit joins the dev stack
scripts/dev.sh remote 'cd /root/lume-dev/src && tok="$(docker logs lumedev-api-1 2>&1 | grep -o "setup token: [A-Za-z0-9_-]*" | tail -1 | cut -d" " -f3)" \
  && docker run --rm --network host --add-host lume.localhost:127.0.0.1 -e NODE_TLS_REJECT_UNAUTHORIZED=0 -e SETUP_TOKEN="$tok" \
     -v /root/lume-dev/src:/repo -w /repo lumedev-toolbox:latest node infra/scripts/acceptance-1a.mjs'
```

Result (`infra/scripts/acceptance-1a.mjs`, 32 checks):

```
ok   setup is needed on a fresh install
ok   a wrong setup token is refused
ok   setup hands out a TOTP secret
ok   setup creates the owner with 2FA and 10 recovery codes
ok   setup cannot run twice
ok   owner is signed in with 2FA on
ok   owner signs out
ok   signed out means signed out
ok   a wrong password is refused generically
ok   the right password asks for the second step
ok   a password alone opens nothing
ok   a recovery code completes sign-in (9 left)
ok   owner is back in
ok   setup seeded the Admin and Sales roles
ok   owner invites Riya as Sales
ok   the invite email reached Mailpit with a link
ok   the invite page knows who it is for
ok   a breached password is refused
ok   Riya accepts the invite
ok   Riya is signed in with Sales access (reveal, own scope)
ok   Sales never sees full contacts
ok   Sales cannot open people admin
ok   an invite works once
ok   owner disables Riya
ok   Riya's session is dead immediately
ok   audit log records setup.completed
ok   audit log records user.logout
ok   audit log records user.login.failed
ok   audit log records user.login
ok   audit log records user.invited
ok   audit log records user.invite.accepted
ok   audit log records user.disabled
acceptance 1A passed
```

Afterwards the identity tables were truncated so the real first-run setup can be done through the Phase 1C screens. The superuser's attempt to clear the audit log as well was refused — `ERROR: audit_log is append-only` — so its 8 entries from the run remain, as designed.

## CI
- Green: https://github.com/kedar2812/lume-v3/actions/runs/35642192860 (commit `58a88cb`): lint, typecheck, 220 tests across 46 files against Postgres 17 (including the route × role access matrix), e2e, images.

**Status: Phase 1A accepted on the temp build host.**

---

# Phase 1B — Configuration & leads (2026-09-22)

On the temp build host after `scripts/dev.sh up` (migrations `0008_configuration`, `0009_leads`, `0010_lead_rls` applied), from a fresh install, through Caddy (`infra/scripts/acceptance-1b.mjs`, 23 checks):

```
ok   setup with the Coaching preset
ok   the preset seeded Nupuur's pipeline and stages
ok   the preset seeded Struggles and Handled by
ok   owner invites Riya as Sales
ok   Riya accepts the invite
ok   owner creates a lead and sees the full, normalised number
ok   a retried create with the same Idempotency-Key replays instead of duplicating
ok   Riya's list holds exactly her lead
ok   …with the phone masked
ok   …and the email masked
ok   Riya can't search by phone digits
ok   Reveal shows Riya the full contact
ok   the reveal is in the audit log
ok   Riya moves the lead to Call booked
ok   Lost needs a reason
ok   the timeline records it all
ok   Riya gets 404 for the owner's lead
ok   …and can't reveal it
ok   owner takes the lead back
ok   Riya lost the lead at once
ok   …and her list is empty
ok   owner disables Riya
ok   Riya's session is dead
acceptance 1B passed
```

Backups under forced RLS, with those lead rows in place:

```
backup complete   lume-20260922T1613Z.dump.age  164304 bytes
restore test passed
ops_restore_tests: ok=t  {"tables": 42, "migrations": 10}
```

The "raw SQL as lume_app" half of the Phase 1 acceptance is `packages/db/src/rls.test.ts` (own/team/all/unset scopes, child tables, inserts, handoff, deletes, history, backup role), run in CI. Identity, lead and configuration tables were truncated afterwards so the real first-run setup happens through the Phase 1C screens.

**Status: Phase 1B accepted on the temp build host.**

# Phase 1C-1 — Getting in (2026-09-25)

**Commits:** `85a0361` … `1f41768` plus the fixes and docs after them · **Host:** temp build host `lumedev`, dev stack behind Caddy (`https://lume.localhost:8443`), Mailpit for mail.

## Live walkthrough

`apps/web/e2e-live/acceptance-1c1.mjs` drives a real Chromium through Caddy's TLS against the running dev stack, with mail read from Mailpit (`scripts/dev.sh reset-db`, then the command in the script's header). Screenshots are in [`screenshots-1c1/`](screenshots-1c1/). QR codes, TOTP keys and recovery codes are masked in every image.

```
ok   a brand-new installation sends every visitor to the setup wizard
ok   setup shows ten recovery codes
ok   the owner lands in onboarding, signed in
ok   both invites are sent from the Team step
ok   the Coaching pipeline's eight stages are there to review
ok   the veil really blurs the app (the Chrome glass bug stays fixed)
ok   the owner's tour covers the admin tools
ok   the tour replays from Settings
ok   Tasneem's invite arrived: "Nupuur Patil invited you to LUME for Nupuur Coaching"
ok   an admin cannot skip two-step sign-in
ok   Tasneem is enrolled and in the app
ok   Riya's tour has no admin steps
ok   Riya's nav has her sections, Settings included (personal)
ok   the reset email arrived: "Reset your LUME password"
ok   Riya signs in with the new password
acceptance 1C-1 passed
```

| Plan step | Outcome | Screenshot |
|---|---|---|
| 1. `/setup`: token, Nupuur Coaching (Asia/Dubai, AED, AE, Coaching), owner with two-step, recovery codes | ✅ | 01a–01c |
| 2. Owner onboarding: theme, working day, alerts; invite Tasneem (Admin) and Riya (Sales); review the pipeline; take the tour | ✅ | 02a–02c |
| 3. Tour: blur plus one sharp highlight, both themes; replay from Settings | ✅ | 03a, 03b |
| 4. Invite emails in Mailpit; Tasneem's onboarding requires two-step sign-in first | ✅ | 04 |
| 5. Riya's tour has no admin steps; her nav has only her sections | ✅ | 05 |
| 6. Sign out, forgot password, email, new password, sign in | ✅ | 06 |

## Automated

- **Unit and integration:** 71 files, 415 tests (`pnpm test`), plus lint, typecheck and the production web build, all in the gate.
- **End to end:** 47 Playwright tests against the built API and web app on a fresh database, behind an edge proxy that mirrors Caddy, with a real SMTP sink. That covers 16 axe checks (8 routes × 2 themes), 10 screenshots (5 screens × 2 themes) and 2 role snapshots. There are no retries, and two consecutive full runs passed 47/47.
- **CI:** https://github.com/kedar2812/lume-v3/actions/runs/36057266997 (check, e2e, images: all green).

## Findings fixed during acceptance

These were found by running the real stack. None would have shown up in unit tests.

- **Glass had no blur anywhere in Chrome.** With `-webkit-backdrop-filter` written after `backdrop-filter`, the CSS compiler kept only the prefixed property, which Chrome ignores. Sources now write the standard property and the compiler adds prefixes; a test forbids hand-written vendor prefixes.
- **The production web build failed** because client code imported `@lume/core`'s root, which pulls in `node:crypto` and `node:fs`. There is now a Node-free `@lume/core/shared`, a lint rule enforces it, and the gate builds the web app.
- **Signed-out screens rendered in the fallback font:** the signed-out redirect caught `/fonts/*`.
- **The onboarding stage collapsed to a 42px strip:** two CSS classes had the same name in one module.
- **An admin who hadn't enrolled yet couldn't save the first onboarding step,** and saw "LUME" instead of the business name.
- **Settings was hidden from sales reps,** although it holds everyone's own settings and the tour.
- **A submit before hydration was a native GET** that put the email and password in the URL. Every form now posts.
- **`?next=//host` was an open redirect.**
- Smaller fixes: sign-in now steps aside for someone already signed in, and a fresh installation sends people to `/setup`. Contrast fixes in Obsidian and on the aura. The empty "LUME / LUME" line is gone. Announced headings no longer show a focus box. The pipeline list fades where more stages follow. The setup card's shadow is no longer clipped.

## State left behind

The dev database was **reset to a genuine first run** after the walkthrough (`scripts/dev.sh reset-db`). The accounts above were throwaway and are gone. The owner's real account should be created by the owner, with their own password and authenticator app, so its credentials exist only in their password manager and never in this repo or on this machine. The new setup token is in `scripts/dev.sh logs api`.

**Status: Phase 1C-1 accepted on the temp build host.**

# Phase 1C-2 — Leads screens (2026-09-25)

**Commits:** `ec61717` … `64b4247` plus the docs after them · **Host:** temp build host `lumedev`, dev stack behind Caddy (`https://lume.localhost:8443`).

## Live walkthrough

`apps/web/e2e-live/acceptance-1c2.mjs` runs straight after `acceptance-1c1.mjs` in the same throwaway container. It uses the three signed-in sessions that script hands over in `ACCEPT_STATE_DIR`, a temp directory deleted with the container (the command is in the script's header). Screenshots are in [`screenshots-1c2/`](screenshots-1c2/); they show throwaway data only.

```
ok   the phone's country is picked from a searchable list with flags
ok   the new lead opens in the drawer, and the address names it
ok   the saved number carries the picked code, trunk zero dropped, valid for WhatsApp
ok   typing a known number warns, naming the lead and who handles it
ok   closing a filled sheet asks first, then discards
ok   Call booked asks for Struggles, saves it, then moves
ok   the history tells the story in words
ok   the rep sees Aisha's number masked
ok   the owner finds Riya's reveal in the audit log
ok   Priya is gone from Riya's list
ok   a drawer opened from a link is on screen
ok   Riya's old link to Priya explains itself instead of erroring
ok   the skipped lead stays selected, ready to fix and retry
ok   a masked rep's table has no contact column
ok   and no export
ok   search says it's by name
ok   the API agrees: contacts arrive masked, and a number finds nothing
ok   Call booked shows its two leads, as its count said
ok   the count moves with the card
ok   the drag sticks after a reload
acceptance 1C-2 passed
```

| Plan step | Outcome | Screenshot |
|---|---|---|
| 1. Create a lead (country from the picker, code added for you); a second with the same number shows the duplicate warning, naming the owner | ✅ | 01a–01d |
| 2. Move stages: Call booked asks for Struggles first; Lost asks for a reason; History tells it in words | ✅ | 02a–02c |
| 3. The rep reveals a masked contact ("recorded in the audit log"); the owner finds the reveal in the audit log | ✅ | 03a, 03b |
| 4. Reassign one of the rep's leads to the admin; it leaves the rep's list, and the rep's old link explains itself | ✅ | 04a, 04b |
| 5. Bulk move of three: "2 moved, 1 skipped: missing required fields"; the skipped one stays selected | ✅ | 05 |
| 6. Masked role: no contact column, no export, name-only search in the UI and the API | ✅ | 06 |
| Also: the stage strip filters with its counts; a real pointer drag on the board; the drawer in Obsidian | ✅ | 06b, 07, 08 |

## Automated

- **Unit and integration:** 92 files, 543 tests (`pnpm test`), plus lint, typecheck and the production web build, all in the gate.
- **End to end:** 75 Playwright tests on a fresh database behind an edge proxy that mirrors Caddy. They cover the leads specs (create and duplicate warning, the country picker, stage prompts, reassign, bulk skips, the masked rep, WhatsApp hand-off with the tab stubbed, and a deep link under reduced motion) and the board specs (pointer drag, keyboard move). They also include axe checks in both themes for the table, the rep's table, the drawer, the New lead sheet with the country list open and the board, screenshots of the leads table, drawer and board in both themes, and role snapshots of the toolbar, the table header and a drawer for the owner and for a sales rep. There are no retries, and the last full run passed 75/75 with no snapshot updates.
- **CI:** https://github.com/kedar2812/lume-v3/actions/runs/36118723268 (check, e2e, images: all green).
- **Edge limits:** `infra/scripts/check-rate-limits.mjs` passes against the dev stack. Static files are never limited. Two sessions on one address get 450 requests each without a 429. A client without a session is limited after 600.

## Findings fixed during acceptance

The unit tests would have caught none of these. They came from the real stack, the e2e suite, or from reviewing the screenshots before accepting them.

- **Saving a custom field failed with a 500.** A PATCH that set custom fields without clearing any (or only cleared) built `- ()::text[]`, which is invalid SQL. It now builds `ARRAY[...]`, and a test covers set, set-and-clear, and clear.
- **Offices would have been locked out by the edge.** Every JS chunk, font and flag counted against 600 requests a minute per IP, so three browsers on one address got 429s mid-walkthrough. Static files are now exempt, the limit is per session, and there's a per-address ceiling. The client also retries a read once after `Retry-After`, then says the network is busy (never "check your connection"). The API's own sign-in lockouts pass through, and an error page that isn't JSON no longer throws.
- **A lead opened from a link was invisible for people who prefer less motion.** The server rendered the slide's start (off-screen), and the browser switched to a fade that never moved it back. Every animated surface now names its full resting state, and an e2e `toBeInViewport` check covers it.
- **The drawer's Details repeated owner, stage and source** as empty rows. **Unassigned board cards showed "UN"** as if it were a person. **Money in editable cells wasn't right-aligned.** **The board's columns touched the toolbar.**
- **The country list failed contrast in Obsidian** (4.39:1 on the highlighted row); the codes now use a stronger ink.
- **A CI screenshot differed by 412 pixels.** A masked relative time's width ("just now" vs "1m ago") moved the owner's name; visual shots now give every relative time a fixed box.
- **The search box drew two focus rings.**

## Asked for during the phase, and built

- **Phone country picker:** the country is its own control. It's a searchable list of every country with its flag, name and calling code (search by name, ISO or code). The code is added automatically, a pasted international number picks its own country, and a typed trunk "0" is dropped. It's used in the New lead sheet, inline edits and the required-fields prompt. The flags are self-hosted SVGs (country-flag-icons, MIT), refreshed with `node scripts/sync-flags.mjs`.
- **Leads page:**
  - A stage strip with live counts: one click shows a stage, Ctrl or ⌘ adds more.
  - A two-row toolbar by job: stages, view and New lead first, then search, filters, sort and columns.
  - Filters that say what they filter.
  - `N` for a new lead, alongside `/` for search.

## State left behind

The dev database was **reset to a genuine first run** after the walkthrough (`scripts/dev.sh reset-db`). The accounts were throwaway and are gone; the owner still does the real first run. The new setup token is in `scripts/dev.sh logs api`.

**Status: Phase 1C-2 accepted on the temp build host.**

# Phase 1C-3 — Settings (2026-09-26)

**Commits:** `0956104` … `14689df`, then the edge fix and these docs · **Host:** temp build host `lumedev`, dev stack behind Caddy (`https://lume.localhost:8443`), with the live exchange rate from open.er-api.com.

## Live walkthrough

`apps/web/e2e-live/acceptance-1c3.mjs` runs after `acceptance-1c1.mjs` and `acceptance-1c2.mjs` in the same throwaway container. It uses the sessions handed over in `ACCEPT_STATE_DIR` (the command is in the script's header). Screenshots are in [`screenshots-1c3/`](screenshots-1c3/), and 1C-1's and 1C-2's were refreshed in the same run. They show throwaway data only; QR codes and two-step keys stay masked.

```
ok   the owner reaches every settings page
ok   Riya (Sales) sees only her account and About
ok   a page she can't use sends her back to Today
ok   the board shows the renamed stage
ok   the preview shows the field, with its options, before it's saved
ok   the New lead form asks for it
ok   Riya can show Budget band as a column
ok   once hidden from Sales, it's gone from Riya's columns
ok   Omar joins from the email
ok   a lead is given to Omar
ok   Omar's session ends at once
ok   his lead is Riya's now
ok   a lead worth AED 1,000
ok   the quote comes from open.er-api.com, dated
ok   the live rate is plausible (1 AED = 0.272294 USD)
ok   the business currency is now USD
ok   AED 1,000 became USD 272.29, once (1,000 × 0.272294)
ok   the audit log says who changed the currency, and at what rate
ok   About shows the running version (Version 0.0.0) and the restore-test status
acceptance 1C-3 passed
```

`Version 0.0.0` is expected on the dev stack, because it doesn't set `LUME_VERSION`. A release build stamps it.

| Plan step | Outcome | Screenshot |
|---|---|---|
| Settings home by permission: the owner sees every area, a sales rep only My account and About; a page she can't use sends her to Today | ✅ | 01, 02 |
| Rename a stage; the board follows | ✅ | 03 |
| Add a select field; the preview shows it with its options before it's saved; the New lead form asks for it | ✅ | 04, 05 |
| Hide a field from Sales; it leaves Riya's column choices | ✅ | 06, 07 |
| Invite someone by email, then disable them handing their leads to Riya; their session ends at once | ✅ | 08, 09 |
| Switch the currency at the live rate, shown with its source and date; AED 1,000 becomes USD 272.29, once | ✅ | 10, 11 |
| The audit log in words, filtered by action: who changed the currency, and at what rate | ✅ | 12 |
| My account (sessions, two-step, the tour) and About | ✅ | 13, 14 |
| The same screens in Obsidian (Carbon) | ✅ | 15, 16 |

## Automated

- **Unit and integration:** 120 files, 742 tests, plus lint, typecheck and the production web build, all in the gate.
- **End to end:** 127 Playwright tests on a fresh database behind an edge proxy that mirrors Caddy.
  - **New settings specs:** rename a stage and see it on the board; add a field and see it on the New lead form; hide a field from Sales and it leaves Noor's columns; invite then disable (session ends, leads move); read and filter the audit log; switch the currency at a typed rate and back exactly; lose access mid-visit and be told.
  - **Axe checks** on every settings page in both themes, with the currency dialog open, and on the Sales view of Settings.
  - **Screenshots** of Settings home (owner and sales), Business, Pipeline, Fields and Roles in both themes. **Role snapshots** of the Settings nav for the owner and for Sales.
  - The e2e API quotes from a fixed rate table, never the live site. There are no retries, and the last full run passed 127/127 with no snapshot updates.
- **CI:** https://github.com/kedar2812/lume-v3/actions/runs/36176696710 (check, e2e, images: all green for `14689df`).
- **Edge limits:** `infra/scripts/check-rate-limits.mjs` passes against the dev stack, now with a fourth check: 700 router prefetches in one session, none limited.

## Findings fixed during acceptance

These came from the real stack, the e2e suite, or reviewing the screenshots before accepting them. The unit tests caught none of them.

- **A brisk walk through Settings got 429s at the edge.** Next.js prefetches every link on screen, and Settings adds eleven, so a session's 600-a-minute allowance ran out mid-walkthrough. The router's prefetches no longer use a person's allowance; they still count toward the address's ceiling.
- **The invite form preselected the first role, usually Admin.** One quick invite could have handed out full control. The role is now chosen on purpose.
- **Settings treated every 403 as "your access changed".** A refusal with its own reason, like granting more than you hold, now shows that reason and keeps the page.
- **Contrast:**
  - Green text on its soft tint was 4.49:1 in Porcelain.
  - Muted text on a selected row, and the role summary's scope words, fell under 4.5:1 in Obsidian.
  - All are fixed. A token test now checks every status ink on its own tint, in both themes.
- **The Fields preview and the New lead sheet's custom fields showed every control as active.** In a form they now rest on a hairline until focused.
- **Roles:** the list column overflowed under the editor, because an input's intrinsic width sized the grid track. **About:** its definition list held a `<p>`. **My account:** the Help card sat outside the page's column.
- **A button's icon could drop to a second line** ("Let's go →"), because the reset makes `svg` a block.

## Asked for during the phase, and built

- **One currency for all of LUME:** set in setup and Settings. Switching quotes the live rate (open.er-api.com), shows exactly what will convert, lets the rate be corrected or typed when the live one is unavailable, and converts once on the server.
- **The licence agreement, terms and privacy policy come first**, before onboarding. "I agree" unlocks only at the end of the text. The text is a **draft for a lawyer's review**: when it's final, set `LEGAL_DRAFT=false` and bump `LEGAL_VERSION`, and everyone agrees again.
- **Dark mode in the Carbon shade**, chosen from five on a comparison page. Cards and popovers step clearly off the page, and a token test holds the steps.

## State left behind

The dev database was **reset to a genuine first run** after the walkthrough (`scripts/dev.sh reset-db`). The accounts were throwaway and are gone; the owner still does the real first run. The new setup token is in `scripts/dev.sh logs api`.

**Status: Phase 1C-3 accepted on the temp build host.**

---

# Phase 2A — CSV import

Plan: `docs/superpowers/plans/2026-09-27-phase-2a-intake-csv.md`. Spec: `docs/superpowers/specs/2026-09-27-phase-2-intake-design.md`.

## Automated

- **Unit and integration: 979 tests**, including:
  - the engine: reading, values, mapping, and `mapRow`;
  - drafts, the run, the queue and the report;
  - a 500-row spec §11 acceptance test;
  - the real pg-boss queue running as `lume_app`;
  - retention and the bulk phone fix.
- **End to end: 151 Playwright tests** against the real stack, including `imports.spec.ts`:
  - a CSV end to end;
  - the European file (semicolons, dd.mm.yyyy dates, comma decimals);
  - cancel, then import the rest;
  - the bulk phone fix;
  - a rep without Import leads.

  Axe checks cover each import step and Settings → Imports, in both themes. Screenshots cover Columns, Preview and the report.

## Live walkthrough

`apps/web/e2e-live/acceptance-2a.mjs` runs after 1C-1 → 1C-2 → 1C-3 in one container.

Passed live:
- **1C-1, 1C-2 and 1C-3**, re-run with the fictional Brightpath Studio. 1C-1 now picks the Dubai coaching business explicitly, since setup no longer defaults to it.
- **The 500-row messy file through the UI:** File → Columns → Rules → Preview → Import → report.
- **The counts:** 400 created and 100 merged, with no problems.
- **Zero duplicates:** every email belongs to exactly one lead.
- **Phone statuses:** 388 valid, 4 invalid, 8 missing.
- **Re-imports:** the same file again merges all 500; a shuffled copy creates nothing.
- **The failed-rows download** is a CSV with defused formulas.

**Update 2026-09-28:** the rest now passes live too: the bulk phone fix, Settings → Imports, and the Obsidian report. Two checks in the script were wrong (one asked once instead of waiting for the list; one matched two headings) and are fixed. The whole chain (1C-1 → 1C-2 → 1C-3 → 2A) ran on a freshly reset dev database, with the owner's go-ahead for the overnight run.

## Findings fixed during acceptance

- **The API could stop answering under a burst of page loads (pool deadlock).**
  - Cause: `GET /api/v1/setup/status` held its request transaction while asking the same pool for its query. About nine at once (the pool of 10, less the RBAC listener) held every connection, each waiting for another.
  - Fix: the check now runs without a transaction; import work uses its own `jobPool`; and the API pool times out instead of hanging.
  - Test: a 24-request burst.
- **One row the database refused failed the whole import.** A 13-digit amount overflowed `numeric(14,2)`, the run retried five times, then failed.
  - Fix: amounts now have the lead form's ceiling (`AMOUNT_TOO_LARGE`), and a data or constraint error on one row rolls back only that row (`ROW_NOT_SAVED`).
- **Extra phone numbers in the history were unmasked for masked roles.** They are now masked by the lead's own rule.
- **The import report:**
  - it had no styles;
  - the table rows were misaligned;
  - an import that added nothing claimed "is in LUME" with a tick;
  - its lines didn't agree in number when the count was 1.

  All fixed, from screenshot review.
- **A board-move reload race** in the 1C-2 script. The script now waits for the save.

## Asked for during the phase, and built

- **Ownership:** LUME is owned and created by Kedar Uttam Gurav. This is in `LICENSE`, `package.json`, Settings → About, and the licence agreement, whose version moved on so everyone agrees again.
- **Password fields:** every one has an eye to show or hide the password, and an announced "Caps Lock is on".
- **First-run setup:** the card fits the window, and a tall step scrolls inside it.
- **2B (spec §12):** Refresh on Leads with a sync card, "{n} new leads", and a 5-second arrival highlight.

## State left behind

The dev stack runs the owner's own demo workspace, set up by the owner through the wizard. `docs/demo/sample-leads.csv` holds 42 fictional leads to import. Reach the stack through `ssh -N -L 8443:127.0.0.1:8443 -L 8025:127.0.0.1:8025 lumedev`, then https://lume.localhost:8443 (mail at http://localhost:8025).

**Status: Phase 2A built and fully accepted, in CI and on the dev stack.**

---

# Phase 2B-1 — Google Sheets, Refresh and the arrival glow

Plan: `docs/superpowers/plans/2026-09-27-phase-2b1-sheets-refresh.md`. Spec: `docs/superpowers/specs/2026-09-27-phase-2b-google-sheets-design.md` (with amendments A1–A13).

## Automated

- **Unit and integration tests:**
  - the Google client against a fake Google over real HTTP (tokens, retries, 403 rate limits, setup problems);
  - reading rows, header drift, fingerprints and anchors;
  - the sync engine: incremental reads, re-sorts, problem retries, pauses, lost access, renamed tabs, the row limit, "only rows from now on", and edits that change how rows are recognised;
  - `requestSync` concurrency;
  - the sheets API, Refresh and arrivals (per-viewer counts under row-level security);
  - every screen.
- **End to end** (`sheets.spec.ts`, against a fake Google on the real stack):
  - the wizard;
  - Refresh with the real count and the glow;
  - a rep's own count;
  - Reduce Motion;
  - Sheets off hides Refresh;
  - screenshots of Integrations and a sheet's page in both themes;
  - axe on Settings → Integrations.

## Final review (fresh reviewer, whole branch)

It found one Critical and eight Important issues, all fixed with a failing test first.

**Critical:**
- An edit that changed how rows are recognised re-imported the whole sheet.

**Important:**
- A gap filled in mid-sheet could be missed for ever.
- A stopped or restarted sync held its lock for 15 minutes.
- Pause and Remove didn't stop a running sync.
- Drive's 403 rate limits read as lost access.
- A row typed over two syncs made two leads.
- A date's display format was part of a row's identity.
- The problem-rows download ignored contact masking.
- Editing reset the check interval.

Eleven minors are deferred; they are listed in the overnight summary.

## Live walkthrough

`apps/web/e2e-live/acceptance-2b1.mjs` runs after 2A in the same chain. On 2026-09-28 it passed step 1 (Settings → Integrations shows Google Sheets off, and without a key says who can set it up).

**Steps 2–3 need the owner:**
1. A Google Cloud service account with the Sheets and Drive APIs enabled. Its JSON key goes on the box at `/root/lume-dev/secrets/google-sa.json` (mode 600, never in git); `dev.sh up` picks it up.
2. A test sheet shared with the key's `client_email` as a Viewer.
3. Then run: `ACCEPT_SHEET_LINK='https://docs.google.com/spreadsheets/d/…' node apps/web/e2e-live/acceptance-2b1.mjs`.

By hand, once: sort the sheet (nothing new); rename a mapped column (the sheet pauses, and Leads shows the banner); fix it (Open columns → Save).

## State left behind

The dev database was reset for the run. It now holds the fictional Brightpath Studio workspace from the acceptance scripts (owner Maya Kapoor), not the owner's own demo account. **Status: Phase 2B-1 built; accepted in CI and on the dev stack, except the steps that need a real Google key.**

---

# Phase 2B-2 — Connect with Google (behind its switch)

Plan: `docs/superpowers/plans/2026-09-28-phase-2b2-connect-with-google.md`. Owner's setup: `docs/runbooks/connect-with-google.md`.

## Automated

- The relay protocol: signing, sealing, and refusing tampering or another instance's token.
- The relay (`apps/connect`), against the fake Google's OAuth endpoints:
  - start refuses unknown instances and bad signatures, and never redirects elsewhere;
  - consent asks only for `drive.file`;
  - the Picker page;
  - the sealed hand-back goes to the registered instance only;
  - refresh, and revocation.
- The instance:
  - each sheet reads with its own credential;
  - a revoked grant pauses the sheet;
  - the relay down is a passing failure;
  - start is signed for this instance;
  - complete is single-use, for the person who started it, and refuses tampered, foreign and expired hand-backs;
  - a sheet is made from the picked file.
- The screens: Connect with Google first, "Other ways", the page Google returns to, and the picked file's tabs.

## Live

This waits on the owner's steps: Google's verification of the consent screen, and the relay's deployment. Until `GOOGLE_OAUTH_RELAY_URL` is set on an instance, nothing about it shows there.

## Final review (fresh reviewer, whole branch)

No Critical issues. Four Important issues, all fixed with a failing test first:
- A grant someone removed in their Google account said "share it with…". Now it says what happened, and the sheet's page offers **Connect again**, which accepts the same file only.
- A picked file could be drafted only once, so going back a step failed. The hand-back also stayed in the address.
- The relay was asked for a token on every sync. Tokens are now reused for their hour.
- A relay that doesn't know this instance was treated as a passing failure. It's now a setup problem the page names.

The ten Minor findings are listed in the overnight summary (`docs/overnight-2026-09-27.md`).

# Phase 2C — Webhooks (website forms, Zapier, Make; ManyChat hidden)

Plan: `docs/superpowers/plans/2026-09-28-phase-2c-webhooks.md`. Spec: `docs/superpowers/specs/2026-09-28-phase-2c-webhooks-design.md`.

## Automated

- **Pure:**
  - reading JSON and form bodies;
  - paths with arrays and deep nesting;
  - the presets' mappings;
  - the rate limiter.
- **Receiving** (the real route):
  - signed and token modes, each with its failures: a bad or stale signature, whitespace changing the body, a wrong token;
  - an unknown source answers exactly like a bad secret;
  - paused gives 503 with Retry-After, and the module switched off gives 401;
  - replays and five identical posts at once make one event;
  - 429, 413, 415 and 400 are counted and never stored;
  - form bodies;
  - a draft keeps its test post.
- **Processing:**
  - a post becomes a lead through the 2A engine, and its history names the webhook;
  - the same person again merges;
  - a post that can't be read is a problem, and goes through after a fix;
  - a huge value is a problem, not a crash;
  - posts wait while the person it runs as can't add leads;
  - new paths are offered;
  - webhook leads count as arrivals.
- **Managing:**
  - off by default, and switching it on is audited;
  - the secret is shown once;
  - ManyChat stays hidden;
  - test post → draft → save;
  - a new secret stops the old one;
  - pause and resume;
  - retry and dismiss;
  - remove;
  - closing the setup keeps the webhook;
  - someone who can't add leads can't set up its columns;
  - every route is in the access matrix, the public receiver included.
- **End to end** (`webhooks.spec.ts`):
  - switch on, Add a webhook, read the address and secret, and a signed post from the test runner;
  - the usual steps, then Turn it on: the lead arrives and glows;
  - the same phone again merges ("Enquired again");
  - a forged post is refused and counted;
  - screenshots of the card, the webhook's page and the secret step (codes masked);
  - axe on both pages in both themes.

## Found and fixed during the build

- Throwing away a webhook's draft (closing the setup) deleted the webhook itself, because the 2A discard removes a draft's source. Only the draft goes now. Test: "closing the setup throws away only its draft".

## Live walkthrough (2026-09-28, the dev stack through Caddy's TLS)

`acceptance-2c.mjs`, run after the whole chain (1C-1 → 1C-2 → 1C-3 → 2A → 2B-1) on a freshly reset stack:
- Webhooks are off until switched on, and ManyChat isn't offered.
- Add a webhook → Website form. Its address is `https://lume.localhost:8443/webhooks/in/<id>`.
- A signed test post from outside, through Caddy, is accepted. The test post becomes one lead after the usual steps.
- A forged post is refused, nothing forged gets in, and the webhook's page says "1 refused · last for a bad signature".

Screenshots: `docs/runbooks/screenshots-2c/`.

# Phase 3A — Follow-ups and the scheduling engine

Plan: `docs/superpowers/plans/2026-09-28-phase-3a-follow-ups-engine.md`. Spec: `docs/superpowers/specs/2026-09-28-phase-3-follow-ups-design.md`.

## Automated

- **The reliability suite** (report §10.4, `engine.test.ts`):
  - fire-time accuracy (the sweeper leaves a reminder alone until 30 s after its time);
  - the job twice, and the sweeper at the same time, make one notification;
  - a reminder whose job never ran is fired by the sweeper once;
  - **crash recovery:** a fire that locked the row and died is picked up by the next sweep, once;
  - a done follow-up tells nobody;
  - a lead the assignee can no longer see is never named;
  - a moved follow-up's old job fires nothing;
  - editing only its words never re-sends a fired reminder;
  - a fire never waits on its own pool.
- **Times** (`time.test.ts`):
  - presets in Dubai, Kolkata and London;
  - "Tomorrow 10:00" across the autumn change;
  - the spring gap and the autumn overlap;
  - weekly repeats keeping 10:00 local;
  - a series three weeks overdue.
- **The API:**
  - set, move, snooze, done, cancel;
  - the lead's next date;
  - repeats and their stops (won, their last day, a reply);
  - done twice at once;
  - Manage others' follow-ups by scope;
  - a follow-up on a lead its assignee can't see is refused;
  - removing a lead cancels its follow-ups;
  - a queue that's down never crashes LUME.
- **Row-level security:** follow-ups are seen with their lead; notifications only by their recipient; backups hold both.
- **The live stream** (real sockets):
  - only its person receives a notification;
  - a notification that commits after a later one still arrives;
  - more than 50 missed are replayed;
  - `?after=` resumes a stream;
  - an open stream never holds up shutdown.
- **Web:**
  - the follow-up sheet and next follow-up;
  - Today: groups, done, All clear with no sound on opening, and a repeat due again today;
  - the bell;
  - the stream reconnecting after a 502 and dropping repeats.
- **End to end** (`follow-ups.spec.ts`), on the real stack:
  - set from the drawer;
  - on Today;
  - due in 5 s, and the bell lights without a reload;
  - done, and All clear;
  - screenshots and axe in both themes.

## Final review (fresh reviewer)

Two Critical, six Important, and nine Minor findings. Four Minor ones were re-graded Important by their effect. All were fixed with a failing test first.

**Critical:**
- A moved or snoozed follow-up fired at its old time and never at its new one.
- Backups held no follow-ups or notifications: the backup role had no read policy under FORCE row-level security.

**Important:**
- The stream lost notifications that committed out of id order, and replayed at most 50.
- A browser's stream died for good after an API restart's 502.
- The hub's LISTEN gave up after one failed reconnect.
- Open streams kept the API from shutting down cleanly.
- Today showed All clear while a repeat was due again today, and played a sound on opening.
- Re-graded from Minor:
  - fires could starve on the job pool;
  - a queue failure crashed the API;
  - J/K could show the previous lead's follow-up;
  - the "For" picker showed choices that always fail.

## Live

`acceptance-3a.mjs set` → `docker restart lumedev-api-1` → `acceptance-3a.mjs check`: a follow-up due 90 s after being set, with the API restarted in between, still reminds exactly once. Screenshots are in `docs/runbooks/screenshots-3a/`, unmasked.

# Phase 3B — The notification centre, escalation and the morning email

Plan: `docs/superpowers/plans/2026-09-28-phase-3b-notification-centre-digest.md`. Spec: `docs/superpowers/specs/2026-09-28-phase-3-follow-ups-design.md`.

## Automated

- **Your own alerts** (`notify.test.ts`): each person's alert settings decide what reaches them; assignment notices are one per bulk action and name the lead only.
- **Escalation** (`escalation.test.ts`):
  - a follow-up overdue past Settings → Follow-ups' hours reaches the owner and team leads who manage its assignee, once;
  - never the assignee, never someone who can't see the lead;
  - off means off.
- **The morning email** (`digest.test.ts`):
  - once a local day, at the person's own time, on their working days;
  - first names and times only: no phones, emails or full names;
  - a mail that fails leaves no record, so the next run tries again.
- **Web:**
  - the centre: groups, filters, read after 600 ms under the pointer, Mark all read, Done / Snooze / Remind them, J/K/E/Enter/F/Esc, live arrivals, the empty state;
  - an update's time says how long ago it arrived; an overdue follow-up says "overdue" once;
  - Settings → Follow-ups (hours 1–168, refused in LUME's words before the server is asked);
  - My account → Notifications (each switch saves as it flips; the email time steps back when the email is off).
- **End to end** (`notifications.spec.ts`), on the real stack with the follow-up clock at 2 s (`LUME_FOLLOW_UP_TICK_MS`):
  - an overdue follow-up reaches the owner live, after Settings → Follow-ups is set to an hour;
  - `.` opens the centre; F goes full screen and Esc steps back; J then E finishes a follow-up; Remind them; Mark all read;
  - the morning email arrives through the SMTP sink with first names and times, and no contact details;
  - screenshots and axe in both themes; full copies in `apps/web/e2e/__review__/notifications/`.

## Final review (fresh reviewer)

No Critical findings. Eight Important ones, all fixed with a failing test first:
- **Two digest runs at once could both send, and a hung mail server held up start-up and the reminder sweep.** Reminders are swept first; escalation and the digest now run beside the clock, one run of each at a time. The day is claimed before sending, and handed back if the send fails. The mail server gets explicit timeouts.
- **A done, cancelled or moved follow-up left its reminder unread,** with no row to read it from. Its reminders are now read for its assignee, whoever did it.
- **"Open" and Enter left the centre over the lead's drawer, and the centre took the drawer's keys.** Opening a lead closes the centre. Its keys work only when focus is in it, or nowhere with no other sheet open.
- **J/K from a row's button jumped to the first row, and an open Snooze menu didn't keep its keys.** The current row is the one holding focus. An open menu keeps its keys, and after E, focus moves on to the next row.
- **The window's "(n)" was lost on the next page,** and hover-reading didn't update the bell. Every read now says how many are left.
- **A follow-up's own words could carry a phone number or email into the email.** They're taken out; the title stays.
- **One person LUME couldn't read stopped everyone's digest,** and failures left no trace. Each person is on their own, and failures are logged by user id.
- **The digest had no instance switch.** Settings → Follow-ups → Morning emails turns it off for everyone. With no mail server it isn't attempted.

Also fixed:
- reassigning a follow-up lets the new assignee's managers hear about it;
- switching escalation on starts from now, so what was already overdue doesn't flood managers;
- "Remind them" is never muted;
- overdue items older than six days show their date;
- overdue items can't crowd today's out of the email;
- changing the digest time back is saved;
- a failed load of Settings → Follow-ups says so instead of showing defaults.

The deferred minors are in the plan ledger.

## Live

`acceptance-3b.mjs set` (with 3A's set) → the chain forgets the owner's digest for today → `docker restart lumedev-api-1` (a restart runs the digest at once) → `acceptance-3b.mjs check`: the morning email arrives in Mailpit with first names and times only, and `.` opens the centre. Screenshots are in `docs/runbooks/screenshots-3b/`, unmasked, including the email as it renders.

Found in the live run: a follow-up overdue from earlier the same day read "(Mon 15:14)" in the email. It now reads "(15:14)"; only an earlier day carries its weekday. Test: "overdue from earlier today reads as its time". (The committed screenshot is from before the fix.)

# Phase 3C — Stage automations, leads gone quiet, working hours, time choices and System health

Plan: `docs/superpowers/plans/2026-09-28-phase-3c-automations-health.md`. Spec: `docs/superpowers/specs/2026-09-28-phase-3-follow-ups-design.md`.

## Automated

- **Times and rules** (`rules.test.ts`, `time.test.ts`):
  - working hours: Friday evening lands on Monday morning, a weekend in Kolkata, 09:00 kept across London's autumn change;
  - time choices: in minutes, hours or days; a day and a time; the next weekday; a time gone today means tomorrow; 3A's five give what they always gave;
  - the shapes refused in words: no working days, a day that ends before it starts, six automations, telling nobody.
- **Stage automations** (`automations.test.ts`), on a real database:
  - a bulk move of 100 leads makes one follow-up each; again, none; out and back while one is open, none;
  - a person who can't take it hands it to the lead's owner; with no owner, nothing, and the history says why;
  - LUME's own follow-up lands inside working hours, unless that's switched off;
  - a win clears open follow-ups and their reminders; telling someone reaches the owner, never the mover, never someone who can't see the lead;
  - a webhook's lead runs its first stage's rules, a CSV import's don't; a new install's Won and Lost clear open follow-ups.
- **Leads gone quiet** (`no-touch.test.ts`): off by default; once per quiet window; never with an open follow-up, a closed lead or a disabled owner; 500 a run; two runs at once never give a lead two.
- **System health** (`health.test.ts`): late reminders, failing morning emails, a source that needs attention and a failed restore test, each in words; each problem reaches admins once a business day, in the app and by email, never a rep.
- **Web:** a stage's automations sheet (sentences as they're shaped, five at most, refused in words first); the summary under Pipeline & stages; time choices (add, rename, reorder, remove, set when each lands); working hours; Settings → Follow-ups' new switches; the follow-up sheet's choices from Settings (and a choice removed while it was open); history lines for LUME's own work; System health (healthy, what needs a look, checks every 30 s while on screen).
- **End to end** (`automations.spec.ts`): an admin sets what a stage does through the screen and a lead moved there has its follow-up and the history line; a win clears follow-ups; a new time choice appears in the follow-up sheet and lands when it says; working hours and System health; screenshots (full copies in `apps/web/e2e/__review__/automations/`) and axe in both themes.

## Found and fixed during the build

- CI ran each package's tests with vitest's 5 s default: the 600-lead test timed out there, and the run it left holding the lock failed the next test. It now seeds in one statement.
- Formatted files copied back from the build box once overwrote a real change (the audit log's words) with an older copy left by a stash check. Restored, and the build notes now say when copying back is safe.

## Final review (fresh reviewer)

No Critical findings. Six Important ones, all fixed with a failing test first:
- **A rule that failed unexpectedly could fail the stage move**, or a whole bulk move. Each rule now runs in its own savepoint: it's rolled back, the history says LUME couldn't do it, and the move and the next rule go on.
- **A bulk move sent one notice per lead.** Notices from rules are gathered per request: "LUME set you 20 follow-ups", "20 leads moved to Contacted", once each.
- **A lead from a webhook or a sheet never told the person its source runs as**, and its follow-ups had them as author. Intake has no mover now: they hear, and the follow-up has no author.
- **Two API processes could both send the same admin alert.** Claims are taken under an advisory lock.
- **"Leads gone quiet" ignored finished follow-ups and WhatsApp.** Both count as contact now.
- **A rule naming someone no longer active trapped the admin.** They show as "(no longer active)" and can be taken out, and the refusal names them and the automation.

Also fixed: clearing with nothing open writes nothing; "morning emails aren't going out" needs more than one person failing, or none sent; unreadable background jobs are a problem, not zeros; Settings → Follow-ups saves can't overwrite each other. The deferred minors are in the plan ledger.

## Live (2026-09-29, the dev stack through Caddy's TLS, on a fresh install)

The whole chain, `1C-1 → 1C-2 → 1C-3 → 2A → 2B-1 → 2C → 3C → 3A → 3B` (with 3B's and 3A's checks after an API restart), on a reset stack:
- a new install's Won stage clears open follow-ups;
- the second open stage is given "set a follow-up in 2 days" through Pipeline & stages; a lead moved there has it, the drawer shows it, and its history says "LUME set a follow-up";
- moving that lead to Won clears it;
- Settings → Follow-ups (leads gone quiet, working hours, time choices) and Business → Working hours;
- System health says "Everything is running".

Screenshots: `docs/runbooks/screenshots-3c/`, unmasked. (1C-3's settings count moved from 14 to 15 pages with System health.)

# Phase 4A — Templates, and sending from them

Plan: `docs/superpowers/plans/2026-09-29-phase-4a-templates-sending.md`. Spec: `docs/superpowers/specs/2026-09-29-phase-4-whatsapp-templates-design.md`.

## Automated

- **Rendering** (`render.test.ts`, in `@lume/core`): every field type in the lead's own words (a date as "12 Oct", a time in the business's zone, money as "AED 1,200", a choice by its label); what's missing is left as written and listed; no contact field is ever a variable; WhatsApp's *bold* and _italic_.
- **Templates API** (`templates.test.ts`): each edit to the words is a new version, and a version is never changed or deleted; a manager sees every template, anyone else only their role's; archive, restore (while the name is free) and order; the audit log in words.
- **Sending** (`sending.test.ts`): the preview's context has names and non-contact fields only; the version a person saw still sends after an edit, and history names the template as it was called; Sent is logged once, finishes the follow-up it came from once, and moves the lead once, saying where it came from; a move the stage refuses leaves the send logged and says why; They replied logs, moves and stops "until they reply" repeats; a lost lead moved back is reopened; a masked rep never gets the number back, except in the wa.me link.
- **Web:**
  - Templates: grouped by kind, each first line in words (variables as chips, *bold* as bold); drag or Alt+↑/↓ to reorder; archive with Undo; the editor's `{{` suggestions, the count, "Saved as version N", roles, preview as a real lead (fetched once, then local); a new template's editor stays open when saved.
  - The send sheet: the context's kind first; a template in the lead's words, still editable; what's missing underlined and said; ↑/↓, Enter, Ctrl/⌘+Enter; the version and the follow-up it came from.
  - The Sent prompt: the `sent` sound, the move and its Undo, a refused move's words; Not sent is quiet. In the drawer it opens its own row, so it never covers the stage track.
  - The drawer: They replied (and R), Reopen for a lost lead. Today and the notification centre: WhatsApp on each follow-up, and Sent finishes it (the centre's keys wait while its sheet is open).
  - Pipeline & stages: Moves in each stage's Does sheet, and the summary's sentences.
- **End to end** (`messaging.spec.ts`): a manager writes a template with one of the business's fields and sees it as WhatsApp will; a masked rep sends from the drawer (a real new tab, the number never on the page), confirms Sent and sees the move, logs a reply; WhatsApp from Today finishes the follow-up; Reopen a lost lead; screenshots (full copies in `apps/web/e2e/__review__/messaging/`) and axe in both themes.

## Found and fixed during the build

- Saving a new template slid a second editor in and lost "Saved as version 1": the editor now stays for the whole time it's open.
- The message field said "expanded", a word only a combobox may use (axe): it now names its suggestions and the one that's on.
- The Sent prompt covered the drawer's stage track (axe's target size, and it hid the stage names): in the drawer it now opens a row of its own.
- Template lines showed `{{lead.first_name}}`: they show "First name" as a chip, and the chip stays readable on a chosen template.
- Today hid a row's actions unless hovered, and with them its Sent prompt: they stay shown while it asks.
- The live run found the Sent prompt still offering Undo after They replied had moved the lead on (it would have sent the lead back past the reply): Undo now leaves once the lead is somewhere else.
- CI's e2e had been red since Task 4 (the Pipeline screenshot moved when leads.spec's confirmed send started moving Sara Nasser on); caught at Task 8 and the baselines reviewed and updated then. Lesson recorded: read CI after every push, not at the end.

## Final review (fresh reviewer, whole branch)

No Critical findings. Seven Important, and three Minor ones re-graded Important by their effect, all fixed with a failing test first (c148f3a):
- **A double-tap on "Yes, sent" logged the send twice.** The lead is locked while an answer is taken, and the prompt takes one answer per question.
- **R with the send sheet open logged a reply**, and a held R repeated. The drawer's keys wait while a sheet or menu is open; the reply button rests a moment after each tap.
- **A refused move said "Fill these in before moving to this stage".** It now says "It stays in New: Message sent needs Goal".
- **A move to a stage later archived or turned Lost failed on every send.** Such moves are cleared, and Lost can't be a move.
- **Undo re-ran stage automations.** Undo is offered only when neither stage has automations.
- **A failed confirm showed a tick and chimed.** The tick and the sound now wait for the server.
- **The template editor didn't take or return focus.** It does, and keeps Tab inside.
- Re-graded: Esc discarded unsaved template words (it asks first now); Preview as couldn't be used by keyboard; the Sent question wasn't announced to screen readers.

Deferred minors:
- the render context returns lead and owner names even when a role can't see those core fields;
- confirm and prepare accept a follow-up id from another lead;
- two creates or restores with the same name at once give a 500 instead of 409;
- reorder: a failure doesn't put the order back; a template added meanwhile shows "List every template exactly once"; two reorders at once interleave;
- `confirmMessage` in `messages.ts` is dead code;
- money renders "INR 5,000" rather than Intl's local form;
- the send sheet's list doesn't scroll the active template into view (no Home/End either);
- the send sheet closes without an exit animation; the editor under Reduce Motion uses a spring on opacity instead of a 150 ms cross-fade;
- the reply toast's Undo has no stale-Undo guard.

Left as they were (inherited from before 4A): "Sent?" is lost if the drawer steps with J/K or the notification centre closes while WhatsApp is open, and returning from WhatsApp is detected by window focus alone (may miss on mobile). 4C's send queue is the place to revisit both.

## Live (2026-09-29, the dev stack through Caddy's TLS, on a fresh install)

The whole chain, `1C-1 → 1C-2 → 1C-3 → 2A → 2B-1 → 2C → 3C → 4A → 3A → 3B`, on a reset stack, all passing:
- a fresh install has LUME's six starter templates (a first touch and a follow-up among them), and its first stage moves a lead on once a message is sent;
- a masked rep sends a starter from a lead's drawer: it renders in the lead's words, WhatsApp opens in its own tab cut off from LUME, and the page never shows the number or the link;
- Sent moves the lead on as its stage says; They replied moves it on again; the history says which template was sent, and the reply;
- Moves, where an admin sets them.

Screenshots: `docs/runbooks/screenshots-4a/`, unmasked.

# Phase 4B — Saved views

Plan: `docs/superpowers/plans/2026-09-29-phase-4b-saved-views.md`. Spec: `docs/superpowers/specs/2026-09-29-phase-4-whatsapp-templates-design.md`.

## Automated

- **Filters** (`filters.test.ts`, API): no reply for N days (messaged, not answered since, still open); lost N+ days ago, and for a reason; an overdue follow-up (a rep counts only their own); added today in the business's timezone (Auckland, across midnight), by the enquiry date when a lead has one; nonsense refused.
- **Row-level security** (`rls.test.ts`, raw SQL): a view is its owner's or shared by role; managers see every shared one and never others' personal ones; a rep can't change a shared view; nobody saves a view in someone else's name; backups hold them all; leads changing notifies `lume_leads` once per transaction.
- **Views** (`views.test.ts`): personal and shared; sharing is for people who manage views; a taken name in words; a shared "My overdue" counts each person's own and matches their list; a view naming an archived field counts "—" while the rest count; losing the role stops showing a view; each person's own order; the starter views count; audit words. `setup.test.ts`: a new install has the four, shared with Admin and Sales.
- **The live stream** (`notifications.test.ts`): a lead change reaches an open stream as one `leads` event with no id and nothing about the lead; ten changes in a second arrive as at most two; notifications keep their ids.
- **Web:** More filters' quiet group (each control, its address and its chip); views in the address bar and back; the sidebar section (counts, "—", links, in-place opening on Leads, a burst of changes asking once, a view saved elsewhere arriving, Alt+↑/↓, a shared view without Edit, rename, recolour, delete with Undo, lined-up counts); Save view (Just me, sharing for managers); an open view's name, Update view and Close view.
- **End to end** (`views.spec.ts`): the four starter views with counts; a manager saves "Chase list" shared with Sales, a masked rep sees their own count and the list agrees; a lead change elsewhere moves the count without a reload; reorder by keyboard (kept after a reload); delete with Undo; screenshots (full copies in `apps/web/e2e/__review__/views/`) and axe in both themes.

## Found and fixed during the build

- Opening a view while already on Leads kept the old filters, and would have left the page faded: a view now opens in place, and the screen starts fresh for each view.
- The views' drag handle was 20 px wide (axe target size): 24 px.
- Save view at the end of the filters wrapped Sort and Columns onto a second row: it now sits with them, at the right of the bar.
- A rep's counts sat further right than an owner's (no Edit button): every row keeps the button's place.
- A view's count and the visual checks: counts carry `data-live-count` (masked), not `data-volatile` (which also resizes, and broke the relative-time check under the welcome sheet's scale).

## Live (2026-09-29, the dev stack through Caddy's TLS, on a fresh install)

The whole chain, `1C-1 → 1C-2 → 1C-3 → 2A → 2B-1 → 2C → 3C → 4A → 4B → 3A → 3B`, on a reset stack, all passing:
- a fresh install has the four starter views in the sidebar, each with a count;
- the owner filters (Overdue follow-up), saves "Acceptance chase" shared with Sales, and it opens as a view;
- the masked rep sees it with their own count (1), their list agrees, never shows the owner's lead, and offers no edit.

Screenshots: `docs/runbooks/screenshots-4b/`, unmasked.

## Final review (fresh reviewer, whole branch)

No Critical findings. Three Important, and two Minor re-graded Important by their effect, all fixed with a failing test first (bcf59eb):
- **A manager un-sharing someone else's view got a 500.** Only a view's owner can make it private; a manager hears so in words, and the form offers no "Just me" there.
- **Counts didn't match the list with several pipelines.** A view naming no pipeline counts the default one, as it opens.
- **Sharing changes never reached open sidebars.** Counts that don't match the listed views reload the list.
- Re-graded: counts that time moves ("My overdue") now refresh when a reminder arrives or the tab comes back (never a timer); opening the same view again after Close view works.
- Checked and not reproduced: keyboard reordering keeps focus in Chromium (the e2e now moves a view two places).

Deferred minors:
- a malformed stage id stored through the API can break its viewers' counts;
- the sidebar's requests have no guard against arriving out of order;
- a future enquiry date counts as "new today";
- `leads` events reach people who can't see leads, and a hub reconnect doesn't refresh counts;
- a failed Undo or Update view says nothing;
- each lead change costs every visible tab a count scan (the stale checks could be batched);
- the web's fixed filter choices vs the API's ranges;
- an archived pipeline or deleted select option isn't treated as stale;
- a personal and a shared view may share a name.

# Phase 4C — The send queue

Plan: `docs/superpowers/plans/2026-09-29-phase-4c-send-queue.md`. Spec: `docs/superpowers/specs/2026-09-29-phase-4-whatsapp-templates-design.md`.

## Automated

- **Settings → Messages** (`messaging.test.ts`, `MessagingSettings.test.tsx`): 50 leads a run and 150 queued messages a day until changed; each changes on its own, in range, audited; for people who manage settings.
- **Row-level security** (`rls.test.ts`, raw SQL): a run and its items are their person's alone; backups hold them all.
- **The queue** (`queues.test.ts`, API):
  - planning from a view (in its order) and from a selection (its own order), capped at the run size, with who's left out and why;
  - a plan before Start that creates nothing;
  - one run at a time; a run is its person's alone;
  - each lead's words before Send, from the planned version;
  - prepare, then Sent? then the next lead, logged as a queued send;
  - sent, not sent and skip once each;
  - two tabs on one lead (one sends, the other is told and moves on);
  - a lead reassigned, deleted, left without a number, or the rep's rights changed mid-run: skipped with why, and the run goes on;
  - a template edited, then archived, mid-run still sends the planned words;
  - pause, resume and cancel;
  - the daily cap counted from midnight in the person's own timezone (not the business's), pausing the run with its words;
  - a masked rep's every response without the number (the WhatsApp link aside);
  - audit words.
- **Grants** (`queue-grant.test.ts`): existing roles that send messages get the queue at the same scope; new installs' Sales role has it.
- **Web:**
  - the start sheet (who's in, left-out reasons one tap away, the view's kind of template first, today's count, Start, "finish or end your current run first");
  - Resume on Today and in the top bar;
  - the run (Send, Sent? Yes / Not sent, Skip, keys, your own words, a lead that can't be sent, the cap, pause / resume / Esc, back after a reload, the summary and `cleared`, reduced motion, the leaving card inert);
  - selection for someone who may run a queue but not edit in bulk;
  - Popover placement.
- **End to end** (`queue.spec.ts`), with review copies in `apps/web/e2e/__review__/queue/` and axe in both themes:
  - a masked rep runs a three-lead queue from "Lost — re-engage" (sent, skipped, not sent), and the number is never on the page;
  - pause, leave, then Resume from Today;
  - a lead's number taken away mid-run is skipped with why;
  - the daily cap pauses the run in LUME's words.

## Found and fixed during the build

- The Settings screenshots in CI predated the new Messages area: baselines refreshed on the full suite.
- Sales couldn't run a queue at all (no permission by default), and a rep without bulk edits couldn't select leads to message. Sales now has the queue (existing installs through 0030, at the scope each role sends at). Selection is for anyone who may run a queue, and the bulk bar shows only what each person may do.
- The card sliding out stayed pressable and findable (two Send buttons for a moment, and Enter could reach it): it's inert and hidden while it leaves.
- A lead that can't be sent showed an empty message box and a dead Send: it now says why, and Skip (and Enter) is the way on. Skipping it records the real reason for the summary.
- The start sheet opened off the top of the window from a bulk bar high on a short list: popovers now pick the side with room and fit it. Templates' lines show their variables as named chips.

## Live (2026-09-30, the dev stack through Caddy's TLS, on a fresh install)

The whole chain, `1C-1 → 1C-2 → 1C-3 → 2A → 2B-1 → 2C → 3C → 4A → 4B → 4C → 3A → 3B`, on a reset stack, all passing:
- Settings → Messages shows the run size and the daily limit;
- a masked rep selects two of their leads and starts a queue from the bulk bar (First hello first; today's count);
- Send opens WhatsApp in its own tab, cut off from LUME, and the page never shows the number;
- Yes moves on; Esc leaves the run paused, and Today offers Resume · 1 of 2 (the top bar too);
- Skip, then the summary: 1 sent, 1 skipped.

Screenshots: `docs/runbooks/screenshots-4c/`, unmasked.
