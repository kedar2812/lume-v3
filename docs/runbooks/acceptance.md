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
