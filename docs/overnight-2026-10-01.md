# Overnight, 30 Sep – 1 Oct 2026: licensing finished, the minors swept, Phase 5A's backend built

## At a glance

- **Licensing is built, reviewed and live on the dev host.**
  - L-A: the instance's licence.
  - L-B: the licence server.
  - L-C: releases and the fleet.
  - The licence server runs at `127.0.0.1:8480` on the dev host, hardened: no capabilities, a read-only filesystem, and the master key in a file.
  - It is **not yet public**: license.lumecrm.in has no DNS record (see "What I need from you").
- **Every deferred minor finding since Phase 2 is dealt with: about 100.**
  - Most are fixed, each with a test that failed first.
  - A few are recorded rulings, with reasons.
  - A fresh review of the sweep found 13 issues worth fixing; all 13 are fixed.
- **Phase 5A (Google Calendar, lead meetings only): the backend is built and reviewed.**
  - The spec is a draft for you: `docs/superpowers/specs/2026-10-01-phase-5-calendar-design.md`. Every choice I made for you there is marked **Decided:**.
  - The plan: `docs/superpowers/plans/2026-10-01-phase-5a-google-calendar.md`. Tasks 1–6 are done.
  - **Connecting:** a person connects their Google Calendar through the relay. It's read-only, with two scopes.
  - **Sync:** every 5 minutes LUME keeps only the events its rules match to leads. A personal event is never written anywhere; a test reads every column of every table to prove it.
  - **Meetings:** they follow their lead's visibility. Disconnect forgets the grant and the meetings it brought. After a meeting ends, its owner gets a "Log outcome" follow-up.
  - **Switch:** Calendar is an optional module, off until an admin switches it on.
  - **Review:** a fresh review found 1 Critical issue: a lead holding your own address would have pulled your whole calendar in. It also found 3 Important issues, and I re-graded 4 more to Important. All 8 are fixed, each with a test that failed first.
  - **Task 7 (the screens) waits for your approval of the Calendar artboards**, as Phase 4 and licensing did. Until then nothing in the app shows Calendar: `CAPABILITIES.calendar` stays off.
- **Tests:**
  - full unit suite 2,071/2,071;
  - typecheck and lint clean;
  - CI green through 26af836 (the full browser suite included).
  - Two CI failures today were in the tests, not the product, and are fixed:
    - the personal-events scan ran past 5 s on GitHub's runners;
    - the morning email's greeting now follows the hour, but the browser test expected "Good morning".

## What I need from you

1. **license.lumecrm.in.**
   - Add the DNS record in Hostinger: an A record `license` pointing to `200.97.166.16`.
   - Then the nginx site and certificate. The steps are in `docs/runbooks/licence-server.md` §5.
   - You gave me authority for this, but the Chrome extension never connected all night (I checked through the night), so I couldn't reach Hostinger.
   - Once the record resolves, I can do the nginx and certbot part on the host (certbot 2.9 is already there with its renewal timer).
   - The domain is lumecrm.in. lume.in is parked at Sedo and isn't yours.
2. **The licence admin.**
   - The first password and two-step secret are in `/root/lume-licence/secrets/admin.txt` on the dev host.
   - Sign in, change the password, set up a new authenticator, then delete that file.
3. **Back up offline:**
   - `/root/lume-licence/secrets/signing.pem`
   - `secrets/master.key`
   - `.env`
4. **Connect with Google before it goes live.**
   - Try one sheet in My Drive and one in a shared drive against real Google.
   - The relay now sends only its origin as the referrer. The review flagged that a referrer-restricted Picker key needs this, and only real Google can confirm it.
5. **Phase 5:**
   - Read the spec.
   - Approve Calendar artboards. I'll draw them on the canvas when you say: agenda, week, the drawer's meeting card, Log outcome, the connect panel, and the Integrations switch.
   - Add the calendar scopes to the Google consent screen and start Google's verification (it takes weeks). The runbook has the steps: `docs/runbooks/connect-with-google.md` §4.
   - Before release, one real-Google check:
     - Google should give a sync token after a read of a time window;
     - a long repeating meeting should stay within the 10,000-event read.
     - The fake Google that the tests use can't answer either.
6. **Tag v1.0.0** when you're happy (`docs/runbooks/fleet.md`, "A release").
7. **The clean-VPS acceptance** for the fleet scripts. It's a checklist in `docs/runbooks/fleet.md`.

## Every decision I made for you

Each line is a ruling from a plan's ledger: what I decided, why, and what it costs if I was wrong. The
deferred minors are findings the final reviews graded minor; I left them for you to decide.

<!-- RULINGS -->
### Licensing L-A — the instance

Rulings (17):

- **Global:** Ruling: the plan describes tests in prose; they are written in full, first (standing ruling since 3B) — cost if wrong: none
- **Global:** Ruling: the overnight authority (2026-09-30) stands in for the owner's spec and plan reviews; every decision is ledgered here and in the spec — cost if wrong: the owner overturns a ruling in the morning
- **Task 2:** Ruling: missing LUME_LICENSE_KEY / LUME_INSTANCE_ID don't stop the API booting; the check records why and the week of grace runs out — safer to operate, still enforced — cost if wrong: a config check
- **Task 2:** Ruling: the release flag is a file baked at image build (/app/release.json), not an env var a client's .env could set — cost if wrong: none
- **Task 2:** Ruling: a development build defaults to dev mode (always active) so the dev stack and existing e2e are unchanged; e2e and the L-B live run turn on enforce — cost if wrong: none
- **Task 2:** Ruling: the keeper runs its own 6-hourly timer (the API's pg-boss runs without cron; the task sweeper does the same) — cost if wrong: a missed check after a crash is made at the next start
- **Task 2:** Ruling: "stale at sign-in" is measured from the last try (not the last success), so a licence server that is down isn't asked at every sign-in — cost if wrong: a reminder appears one check later
- **Task 3:** Ruling (revises the plan's R1): nothing NEW starts while locked — the follow-up clock (tick, fire, sweep) and scheduled sheet syncs wait, inbound webhooks are refused; work accepted before the lock (a running import, a queued sync, accepted webhook posts) finishes, so nothing a client already gave LUME is stranded — cost if wrong: a queued import completes during read-only
- **Task 3:** Ruling: suspended still answers GET /api/v1/settings and /api/v1/about (the lock screen needs the business's name; nothing else) — cost if wrong: none
- **Task 4:** Ruling: the export reads on its own connection (the request transaction commits before a streamed body goes out) in one REPEATABLE READ READ ONLY snapshot as LUME itself (every lead, unmasked); the request's own transaction records only the audit — cost if wrong: none
- **Task 4:** Ruling: data.export is its own permission (Admin group), granted by 0032 to roles that change settings — cost if wrong: one migration
- **Task 5:** Ruling: a notice may carry `contact` (mailto:/tel:/https:, from the licence server's settings) so "Contact about payment" goes somewhere real; without one the reminder shows only "I'll sort it" — cost if wrong: none
- **Task 5:** Ruling: the reminder text doesn't name the billing period (the token doesn't carry it); it says the licence "was due on" the due date — cost if wrong: one payload field
- **Task 5:** Ruling: the compact Export (read-only bar, About) shows Exporting… then Download; the lock screen ticks through the files as the canvas draws — cost if wrong: none
- **Final:** Ruling: Check now works while suspended (spec §3.4 lists only GET licence and dismiss) — it's how a lifted suspension is picked up at once — cost if wrong: none
- **Final:** Ruling: a never-set-up install past its 7 days without a key can't run setup (POST /setup refused) — an install is provisioned with its key (L-C), so this never happens in the fleet — cost if wrong: a support call
- **Final:** Ruling (for L-C): a release build with an empty LICENCE_KEYS must fail its build/boot loudly — carried to the L-C plan

Deferred minors (4):

- the read-only banner says "everyone can look and export" but reps don't have data.export
- jobs skipped while locked don't log that they skipped (spec §3.4 says they log)
- the browser holds the whole zip (r.blob()); a failed stream shows a raw "Failed to fetch"
- notes/activity/follow-ups include rows for soft-deleted leads not in leads.csv

### Licensing L-B — the licence server

Rulings (32):

- Ruling: L-A's notice carries an optional `contact` (mailto:/tel:/https:); L-B Settings holds a billing contact that rides in every notice — cost if wrong: one settings field
- **Task 1:** Ruling: dates are UTC calendar days (grace ends the 7th UTC day after paid_until), the same days the instance counts its graceEndsAt in — cost if wrong: grace flips up to 5.5 h off Indian midnight
- **Task 1:** Ruling: raw SQL over pg (no drizzle): the migration is the schema, and every query is small and tested against a real Postgres — cost if wrong: none
- **Task 1:** Ruling: migrate and admin-create are TypeScript entry points (src/cli) bundled to dist/*.mjs at build; keygen stays plain dependency-free JS so it runs on the host before anything else exists; admin-create moves to Task 2 (it needs the sign-in's sealing) — cost if wrong: none
- **Task 1:** Ruling: a licence key is LUME + five groups of four Crockford base32 (100 bits), matching the canvas's key shape; matched case- and space-insensitively as a SHA-256 hash in constant time — cost if wrong: none
- **Task 1:** Ruling: a subscription with no paid_until, or a trial with no end, is read-only rather than free; the per-address limit is 300 checks an hour — cost if wrong: none
- **Task 2:** Ruling: 0001_licence.sql was edited (paying_since, totp_pending, sign_in_pending) rather than adding 0002 — nothing has been deployed with it — cost if wrong: none
- **Task 2:** Ruling: the password step always answers "next: code" and always makes a pending sign-in; only the code step decides, with one message for any failure (Review Focus 4) — cost if wrong: none
- **Task 2:** Ruling: admin sessions end after 4 hours idle or 24 hours whatever; the sign-in limit is 10 tries per address per 15 minutes (each step counts) — cost if wrong: the owner signs in a little more often
- **Task 2:** Ruling: a new subscription's first payment is due the day it's created (paid_until = that day, so grace starts the next day); Mark paid records the payment and moves paid until on one period from the later of today and where it was (the canvas's Extend), held to the month's last day — cost if wrong: a new client shows "due today" until marked paid
- **Task 2:** Ruling: a trial runs 14 days (the canvas's sheet); its first Mark paid makes it a subscription paying from that day (trial-to-paid counts it) — cost if wrong: none
- **Task 2:** Ruling: analytics count a client's revenue from paying_since until it is suspended or decommissioned (its current suspension; a resumed client counts again), at today's rates — cost if wrong: a past suspension that was lifted isn't a dip in the history chart
- **Task 2:** Ruling: the bell's "hasn't checked in" is only for clients that have checked in at least once; suspended and decommissioned clients raise nothing; older versions are one grouped alert whose fingerprint is the latest version plus who's behind — cost if wrong: none
- **Task 2:** Ruling: a new two-step secret is kept aside until a code from it confirms the switch (no lock-out); a password change ends every other session — cost if wrong: none
- **Task 2:** Ruling: exchange rates refresh from instrumentation.ts at start and hourly (a fetch only when today's are missing), which also prunes check-ins past 180 days — cost if wrong: none
- **Task 3:** Ruling: the white-on-green and white-on-red trend chips on the blue and gradient cards are a shade darker than the canvas (#0b7443, #bd2a30; flat is a dark wash) so their text meets WCAG AA 4.5:1 — cost if wrong: a barely visible colour shift
- **Task 3:** Ruling: the panel reuses LUME's own flag set (country-flag-icons, MIT, as apps/web ships in public/flags) and Inter, rather than the canvas's seven flag-icons samples — cost if wrong: flags a touch wider (3:2) inside the same 22×16 box
- **Task 3:** Ruling: a Read-only tile joins the canvas's four state tiles only when a client is read-only (a late subscription past grace, or a trial that ended) — cost if wrong: none
- **Task 3:** Ruling: Mark paid is always there (the canvas disabled it until a payment was late): a yearly client often pays early — cost if wrong: none
- **Task 3:** Ruling: creating a licence shows the key, the instance ID and Copy in the sheet itself ("Licence created", shown once), with Open <client> — the server never has the key again to show on the client's page — cost if wrong: none
- **Task 3:** Ruling: a suspended client's page offers Resume (not on the canvas; without it a suspension couldn't be lifted) — cost if wrong: none
- **Task 3:** Ruling: numbers appear at once rather than counting up (the canvas counted them): steadier to read, and nothing to wait for — cost if wrong: a flourish the owner may want back
- **Task 3:** Ruling: the licence panel e2e (apps/licence/e2e, Playwright, a fresh database seeded with the canvas's clients) was written here to review the screens against the canvas; Task 4 adds it to CI — cost if wrong: none
- **Task 4:** Ruling: the licence server is deployed as its own Compose project in /root/lume-licence on the host (127.0.0.1:8480, postgres:17, a one-shot migrate before the app); the signing key was made there by keygen (secrets/ 700, the key 600 owned by the image's node uid); the admin is admin@lumecrm.in, its first password and two-step secret in secrets/admin.txt (600) for the owner to replace — cost if wrong: the owner signs in and changes both
- **Task 4:** Ruling: the production public key "lume-1" is in LICENCE_KEYS (core test pins it: RED without it, GREEN with) — cost if wrong: a new key and a release
- **Task 4:** Ruling (fixes L-A, found by the live run): the lock screen offers "Check again" to people who may check, so a lifted pause is picked up at once rather than at the next 6-hourly check; a check that's still paused says so — Licence.test "people who may check can check again…" + "a rep has no Check again…" RED→GREEN, web 755/755 — cost if wrong: none
- **Task 4:** Ruling (found by the live run): New licence's lists carry their own names (aria-label); wrapped in their labels, Chromium named them by their options too ("State" matched "United States"). A jsdom unit test passed without the fix (jsdom names them differently), so it was dropped as proving nothing; the check lives in the Chromium e2e instead — panel.spec RED without the fix, GREEN 4/4 with — cost if wrong: none
- **Task 4:** Ruling: the live acceptance points the dev stack's API at the deployed licence server by attaching the licence app to the dev stack's backend network and an override compose file (removed afterwards; the dev stack returns to dev mode) — cost if wrong: none
- **Follow-up (from L-C Task 5):** Ruling: Decommission on the licence server — only once suspended; for good (every other action refuses a decommissioned client, 409), its record stays marked for history and analytics, any open reminder clears — clients.test + panel.test RED→GREEN, licence 105/105, e2e 4/4 — cost if wrong: none
- **Final:** Ruling: hosting the licence server on the dev host and attaching it to the dev stack for the live run — the spec's R1 host; the attachment was removed after — cost if wrong: move it to its own host with the runbook
- **Final:** Ruling: a 14-day trial is active through its last day (15 calendar days counting today) — cost if wrong: one day
- **Final:** Ruling: read-only (8+ days late) subscriptions still count in MRR until suspended — they owe it — cost if wrong: MRR a little high while a client is late

Deferred minors (9):

- missing rates also drop a client from paying/joined/left counts, not only rupee totals
- a payment made on a day the rate fetch failed stores the last known day's rate as "that day's"
- the code step returns faster for an unknown email (a small timing hint)
- admin-create echoes the typed password into the terminal
- .dockerignore doesn't exclude .env*, *.pem, deploy/clients/*.env (only the build stage sees them)
- a malformed %-escape in an API path is a 500, not a 404
- the licence compose passes secrets as environment variables and doesn't drop capabilities
- /v1/check reads the whole body before its 4 KB check (nginx's 64k limit caps it)
- Final: fixed CI's audit failing on a critical Next.js advisory (GHSA-vcvr-r3jv-pc5j, next/og RCE, 16.2.0–16.3.5): both Next apps now on ^16.3.8; the remaining moderate (uuid under exceljs, only when a buffer is passed) is below the audit gate — minor (deferred)

### Licensing L-C — releases and the fleet

Rulings (16):

- **Global:** Ruling: the owner's instruction (2026-10-01: "go ahead and finish phase 4 and licencing", following the previous practice) stands in for the plan review; every decision is ledgered here — cost if wrong: the owner overturns a ruling
- **Task 1:** Ruling: the first release is 1.0.0 (the root package.json had no version); dev builds report it too (appVersion: LUME_VERSION baked into a release, else the root version) — the live run showed a dev install reporting 0.0.0 — licence.test "the version an installation reports" RED→GREEN — cost if wrong: one number
- **Task 1:** Ruling: the release marker is a small script (infra/docker/release-marker.sh) each image runs, so its behaviour is tested directly rather than by building images; caddy isn't marked (it isn't LUME code) but is versioned — cost if wrong: none
- **Task 1:** Ruling: release images are named ghcr.io/<repo>/<image>:X.Y.Z (as CI's per-commit images already are), which is exactly what a client's compose file builds from LUME_IMAGE_PREFIX and LUME_TAG; the plan's "lume-<image>" would have needed a second naming scheme — cost if wrong: a rename
- **Task 1:** Ruling: the workflow test was first written for four literal Dockerfile paths; the workflow builds them with a matrix, so the test now checks the matrix and the file template (same intent: the four images, as releases) — cost if wrong: none
- **Task 2:** Ruling: the stubs are one script (_stub) that ssh, scp, docker, curl and dig hand their name to; staged answers are "regex over the call, exit code, output", first match wins — cost if wrong: none
- **Task 2:** Ruling: lib.sh refuses the build host (200.97.166.16) by address, whatever the inventory says; selftest.sh exists only to exercise lib.sh in the tests — cost if wrong: none
- **Task 3:** Ruling (found while planning provisioning, an L-A gap): the production compose file never passed LUME_INSTANCE_ID and LUME_LICENSE_KEY to the API, so a real client could never check in; now it does (optional in the file, which the dev stack shares; provision.sh refuses without them) — server.test RED→GREEN — cost if wrong: none
- **Task 3:** Ruling: hardening now makes the source spec's user (lume-deploy) and directory (/opt/lume) instead of Phase 0's deploy and /srv/lume; restore.md follows — server.test RED→GREEN — cost if wrong: a server hardened by the Phase 0 script keeps its old user (none exist yet)
- **Task 3:** Ruling: secrets are made on the operator's machine once, kept in the client's gitignored deploy/clients/<slug>.env, and never regenerated; the registry token only ever travels on docker login's stdin; the restore-test age key is made on the server by the release's own worker image — cost if wrong: none
- **Task 3:** Ruling: LUME_TLS is empty on a client (Caddy's automatic HTTPS for <slug>.lumecrm.in); DNS is checked with dig before the server is touched; health is https://<slug>.lumecrm.in/healthz (the API's, through Caddy) — cost if wrong: none
- **Task 4:** Ruling: update.sh backs up with the worker's own run-now ops.backup (encrypted, off-site as configured) and keeps a plain pg_dump on the server for that update (/opt/lume/backups/before-<version>.dump), restored as the container's postgres (peer auth) only when migrations ran; "migrations ran" is anything but a clean "applied":[] — cost if wrong: an unnecessary restore after a failed update, never a missing one
- **Task 4:** Ruling: each client updates in its own subshell (one failure never stops the others); the table is always printed; the exit code is 1 if any client wasn't updated; a client already on the version is left alone — cost if wrong: none
- **Task 5:** Ruling (C3): decommission.sh reads the installation's own stored licence token and decodes its payload's state (no signature check: it only guards a destructive step, and the licence server isn't asked); no token at all is a refusal — cost if wrong: none
- **Task 5:** Ruling: removing LUME's key from the deploy user is the last remote step (nothing can run after it); the client's local .env is deleted after (its secrets open nothing now); the registry token and DNS record are printed for the owner to remove by hand — cost if wrong: none
- **Final:** Ruling: the restore key's directory (700, uid 1000) is checked by compose as lume-deploy; if lume-deploy isn't uid 1000 on a client's image, the owner's clean-VPS acceptance will show it (reviewer declined to judge) — cost if wrong: a chown step

Deferred minors (4):

- a pg-boss upgrade changes its schema outside "applied", so a failed update wouldn't restore for it alone (M3)
- release-marker.sh's version glob accepts non-semver ("1.2.3\""), which would read as a dev build; the workflow's package.json match guards it (M8)
- /healthz doesn't say the version (on_version asks docker for the running image instead) (M10)
- an IPv6 host would need brackets for scp (M6's second half)

### The minors sweep

Rulings (43):

- **Global:** Ruling: the owner's instruction (2026-10-01: "fix all minor issues", full authority while asleep) stands in for the plan review; every decision is ledgered here — cost if wrong: the owner overturns a ruling
- **Global:** Ruling: the plan lists each finding with its fix direction rather than full code (it is a sweep of ~100 small findings across the codebase; each fix's exact code is decided in its task under TDD) — cost if wrong: none
- **Task 1:** Ruling: the database password stays in the compose environment (the app's DATABASE_URL carries it; the db has no published port, only the compose network reaches it); the master key — which unseals the admin's two-step secret — moves to a mounted file (LICENCE_MASTER_KEY_FILE; LICENCE_MASTER_KEY still read when no file, for a dev run) — cost if wrong: one more file mount
- **Task 1:** Ruling: db keeps Postgres's default capabilities (its entrypoint changes ownership and user); app and migrate drop all, read-only root with /tmp and .next/cache in memory — cost if wrong: a write the app needs fails at start (seen at deploy)
- **Task 1:** Ruling: an unknown email's code step does a query and a TOTP check against a secret no one holds; its timing is close to, not identical with, a known one's (which also takes a row lock) — cost if wrong: a sub-millisecond hint
- **Task 1:** Ruling: vitest's moderate advisory (GHSA-82fw-gwwq-j7x9, dev-only, fixed in vitest 4) is new since L-B; a major upgrade of the test runner is not a minor fix — left below the CI gate, noted for the owner — cost if wrong: none at run time (never shipped)
- **Task 2:** Ruling: Export all data is now two steps — POST /api/v1/export prepares the zip into a private temp file (mode 600) while the screen ticks; GET /api/v1/export/:id streams it once to the same person, then deletes it (unfetched ones go after 10 minutes). GET /api/v1/export (streamed directly) stays for scripts. Both sit under the licence guard's existing /api/v1/export/* allowance — cost if wrong: an API restart between prepare and download loses the prepared file (the screen says to export again)
- **Task 2:** Ruling: held-back work is logged once when it stops and once when it carries on, per clock ("the follow-up clock", "follow-up reminders", "scheduled sheet syncs"), not at every tick — cost if wrong: none
- **Task 2:** Ruling: the licence e2e now clicks Download and checks the file is a zip (PK) named for the day; it runs in CI's e2e job with this push — cost if wrong: none
- **Task 3:** Ruling: the release marker checks the version with a case pattern and tr, not grep (grep -x would pass a two-line value on its first line) — cost if wrong: none
- **Task 3:** Ruling: pg-boss's schema version unreadable (before or after) counts as unchanged, so an unreadable database never triggers a restore by itself — cost if wrong: a failed update after a pg-boss upgrade on a box whose psql failed wouldn't restore (the table still says rolled back)
- **Task 4:** Ruling: pg-boss 10 has no per-worker concurrency option; three workers on sheets.sync (each sheet stays one sync at a time by its own row lock) — cost if wrong: three syncs share the API's job pool at once
- **Task 4:** Ruling (finding 11): the 5,000-row read chunks stand (fewer calls against Google's per-minute quota); the 2B spec now says 5,000 — cost if wrong: none
- **Task 4:** Ruling: a row refused while dismissed stays dismissed but still counts as that sync's error (the sync did refuse it) — cost if wrong: one "problem" in a sync's line
- **Task 4:** Ruling: the renamed tab's title is written as soon as the sync sees it (before the rows are read), so it's kept even if that sync then fails — cost if wrong: none
- **Task 5:** Ruling: Drive is asked for the picked file's mimeType with the access token the grant just gave; if Drive can't be reached the relay says so (502) rather than connect a file it couldn't check — cost if wrong: a Google blip means picking again
- **Task 5:** Ruling: the relay's feature keeps its name ("Connect with Google" as the page and section), and the button follows Google's branding ("Continue with Google") — cost if wrong: one label
- **Task 5:** Ruling: a revoke call to Google for a removed sheet's grant (the finding's "later a relay /revoke") is left out: the grant is gone from LUME's database, and a relay /revoke is a new relay endpoint the owner hasn't deployed yet — noted for the owner — cost if wrong: the Google account lists LUME until the person removes it
- **Task 6:** Ruling (finding 1): rather than change what senders sign, each signature is accepted once (webhook_signatures, 0033, swept after 10 minutes); a sender's own event id still dedupes its retries — cost if wrong: a sender that re-sends the very same signed request is told duplicate (which it is)
- **Task 6:** Ruling (finding 10): resuming a webhook that needed attention before it was paused puts it back to needs attention (its reason kept), not active — the fix was never made — cost if wrong: one more click on Test again / the columns
- **Task 6:** Ruling (finding 12): anyone who knows a webhook's address can raise its refused count — it stands: counting refusals is the count's purpose, the address is a secret-ish URL, and the per-source limiter caps it at 60 a minute — cost if wrong: a noisy "refused" line
- **Task 6:** Ruling: the website preset's message goes to a custom field whose key or label is "notes"/"note"; none, it's left out (as spec §5 says) — cost if wrong: a business with "Comments" maps it by hand
- **Task 7:** Ruling (finding 11): leads gone quiet counts from when it's switched on (noTouch.from, as escalation already does) — leads already quiet then don't come back as a flood; the settings copy says so — cost if wrong: an owner who wanted the backlog finds those leads with a filter instead
- **Task 7:** Ruling (finding 3): a stream ends when its session is revoked in this process (sign-out, revoke, password reset; LUME runs one API process per client), and a browser that leaves over 256 KB unread is let go and reconnects from its Last-Event-ID — cost if wrong: a revocation made by a second process leaves the stream until it reconnects
- **Task 7:** Ruling (finding 10): after the follow-up queue starts, "reminders late" waits 5 minutes (the sweeper catches up 500 a minute); "sweeper stopped" still speaks as before — cost if wrong: a real stop right at start is said 5 minutes later
- **Task 7:** Ruling (finding 5): the digest names up to 5 newly assigned leads (first names, each a link), then "and N more" — cost if wrong: none
- **Task 7:** Ruling: the receive test "too big is 413…" raced (refusals are counted after the answer, so their order isn't guaranteed); it now waits for each count — a test fix, the product behaviour is unchanged — cost if wrong: none
- **Task 8:** Ruling (finding 10): "Sent?" lives in a small store (lib/messages/pending): the sheet that opened WhatsApp asks if it's still on screen; otherwise the shell's PendingSent asks, naming the lead; coming back is focus, the tab shown again (visibilitychange) or the page restored (pageshow) — cost if wrong: a second "Sent?" source to keep in step with the sheet's
- **Task 8:** Ruling (finding 8): every Popover now leaves the way it came (140 ms, a fade under Reduce Motion) rather than only the send sheet — one behaviour for all anchored panels; three tests that opened the next panel at once now wait for the last to go — cost if wrong: a 140 ms overlap when panels are swapped quickly
- **Task 8:** Ruling (finding 4): a reorder names the templates it knows; any live one it doesn't name (added meanwhile) keeps its place after them, instead of "List every template exactly once"; one naming a template that's gone is still refused — cost if wrong: none
- **Task 8:** Ruling (finding 6): money renders with Intl's currency style in English (₹5,000, $1,250.50, "AED 1,200" where English has no sign), with a plain space for WhatsApp text — cost if wrong: a business wanting its code shown for every currency
- **Task 8:** Ruling (finding 5): confirmMessage in leads/messages.ts was dead (no route used it) and is gone; the web's leadsClient.confirmMessage is the live confirmSend route — cost if wrong: none
- **Task 9:** Ruling (finding 9): a view shared with someone under the name of one of their own shows "Shared" beside it (names stay as their owners chose; sharing isn't refused) — cost if wrong: none
- **Task 9:** Ruling (finding 7): the address bar takes any value the API takes (no reply 1–365, lost 1–3650, new 1–365); the menus add the value in use when it isn't one of theirs — cost if wrong: none
- **Task 9:** Ruling (finding 10): the templates' keyboard reorder was checked in Chromium in 4B (focus kept) and not reproduced; nothing to change — cost if wrong: none
- **Task 10:** Ruling (finding 3): "Yes, sent" whose lead can't be logged any more (deleted, reassigned, rights lost) is settled sent, with "Sent, but not logged on the lead: <why>" — it went, and the day's cap counts it — cost if wrong: none
- **Task 10:** Ruling (finding 2): with changes not saved, "Message these" runs what's shown (the screen's filters, checked as a view's are) and the run is named "<view> (as shown)" — overturns 4C plan ruling R2's "as the view is saved" for this case only — cost if wrong: the owner wanted the saved view; Update view first restores that
- **Task 10:** Ruling (finding 1): a lost template doesn't skip the rest; each remaining lead asks for the person's own words (the run's template stays named), so nothing is sent from a template their role can't use — cost if wrong: a long run needs typing per lead (End run is there)
- **Task 10:** Ruling (finding 7): 0030's role widening is already in CHANGELOG 1.0.0 and release.test pins it — nothing to change — cost if wrong: none
- **Task 10:** Ruling: the retry is offered at the end (the summary's Not sent list), and on a run that was ended it isn't (ended is ended) — cost if wrong: none
- **Task 11:** Ruling (finding 2): Settings navigation/back arrows and the type scale are the owner's own polish items (memory: "build features first"), not review findings; left to the polish pass the owner schedules — cost if wrong: they're done in the morning instead
- **Final:** Ruling: the reviewer declined to judge read_only + tmpfs for Next standalone — judged: the deployed licence server has run healthy on it since 05:30 (healthz ok, a real sign-in) — cost if wrong: none
- **Final:** Ruling: the behaviour-change rulings the reviewer called reasonable (as shown, sent means sent, quiet from switch-on, every Popover exits) stand — cost if wrong: as their own rulings say

Deferred minors (3):

- #11 webhook signatures kept 10 minutes; a timestamp up to 5 minutes ahead plus clock skew leaves seconds of replay window (keep 15)
- #13 the renamed tab's config write isn't guarded against a Remove landing in the same instant
- #16 customGone treats an archived select option as present; the "two restores at once" test doesn't race; SourceDetail's "Keep it" doesn't clear its error; a catch-up digest sent just after midnight says "Good morning"; switching leads-gone-quiet off and on resets its start; Intl English money gives "CA$"/"A$" and Western grouping for INR

### Phase 5A — Google Calendar

Rulings (35):

- **Global:** Ruling: the owner's instruction (2026-10-01: "get started on phase 5 if possible", full authority while asleep) stands in for the spec and plan reviews; the spec says plainly it's a draft for the owner, and Task 7 (screens) waits for the owner's design approval — cost if wrong: backend tasks redone to a changed spec
- **Global:** Ruling: the plan describes tests in prose; they are written in full, first (standing ruling since 3B) — cost if wrong: none
- **Task 1:** Ruling: the Handoff type change (kind, file optional) has no runtime of its own to test; the instance's sheet complete already refuses a hand-back with no file, so a calendar grant can't become a sheet — cost if wrong: none
- **Task 1:** Ruling: scopes are calendar.events.readonly + calendar.calendarlist.readonly only (no openid/email): the primary calendar's id is the account's address, read with the grant — cost if wrong: one more scope later
- **Task 2:** Ruling: LUME's cross-person reads (which connections are due; which meetings have ended, for Task 6's Log outcome) go through a transaction-local, read-only `lume.calendar_sweep` flag in the read policies, as `lume.manage_views` does for views; writes stay the person's own — cost if wrong: a code path that sets the flag could read others' calendars (never write them)
- **Task 2:** Ruling: no separate `outcome` column — the spec's status (scheduled | cancelled | completed | no_show | rescheduled) is the outcome; `outcome_note`, `outcome_at`, `outcome_by` record it — cost if wrong: one column later
- **Task 2:** Ruling: meetings also keep `matched_by` (why a rule kept it, for "why is this here") and `calendar_id` (so un-choosing a calendar can remove its meetings) — cost if wrong: two unused columns
- **Task 2:** Ruling: a kept event links to the first attendee (organiser last) who is a live lead, whichever rule kept it, even with the attendee rule off (spec §2.2: "unless an attendee also matches"; rule 3 "matched to a lead by attendee when possible") — cost if wrong: one condition
- **Task 2:** Ruling: title words match whole words or phrases, any case, any run of spaces, with letters and digits of any script as word characters ("demo" never matches "Demolition") — cost if wrong: a looser match later
- **Task 2:** Ruling: a meeting goes with its lead (ON DELETE CASCADE), as follow-ups do, so erasing a lead erases its meetings — cost if wrong: none (soft-deleted leads keep theirs)
- **Task 4:** Ruling: Task 4 runs before Task 3 — Task 3's complete reads the calendar list (the account's address is the primary calendar's id, Task 1's ruling), which is Task 4's client — cost if wrong: none (order only)
- **Task 4:** Ruling: the Sheets client's retrying GET (401 refresh once; 429/rate/5xx/network retried 1-2-4 s) and its kept relay token source are extracted (googleCaller, grantTokens) and shared, so a calendar behaves exactly as a sheet does with Google; Google's 410 is a new GoogleError kind "gone", which the calendar client turns into SyncTokenGone, never retried — cost if wrong: none (Sheets suite unchanged and green)
- **Task 4:** Ruling: events are read with singleEvents=true (a repeating meeting is one row per occurrence, so each can have its own outcome) and an all-day event comes through flagged allDay (Task 5 decides what to keep); the calendar list asks for calendars the person can at least read; a window of more than 40 pages × 250 events stops with an error rather than loop — cost if wrong: a busy shared calendar over 10,000 events in 4 months isn't read
- **Task 3:** Ruling: CAPABILITIES.calendar stays false until Task 7's screens exist — capabilities.ts's own rule is that no screen offers what isn't there, and true now would show an onboarding/tour Calendar step leading nowhere — cost if wrong: one line in Task 7
- **Task 3:** Ruling: oauth_connects gains `kind` (0036); each complete finishes only its own kind, so neither hand-back can finish the other's connect — cost if wrong: none
- **Task 3:** Ruling: there is no module switch for Calendar (spec §2.1 has none): it's offered wherever Connect with Google is set up, per person by calendar.connect; disconnect still works without the relay (it only forgets) — cost if wrong: an Integrations toggle later
- **Task 3:** Ruling: connecting again with the same Google account keeps the chosen calendars and their sync tokens and clears needs_reconnect; with a different account, the old connection (and its meetings) goes first — the calendars were that account's — cost if wrong: one branch
- **Task 3:** Ruling: disconnect doesn't revoke the grant at Google (the relay has no revoke, as for sheets); LUME forgets it. Task 7's copy says where to remove LUME at Google — cost if wrong: a relay revoke endpoint later
- **Task 3:** Ruling: un-choosing a calendar removes its meetings at once (they came from a calendar LUME no longer reads) and a newly chosen one is read in full — cost if wrong: one delete
- **Task 5:** Ruling: a cancelled event marks its meeting cancelled (kept, for history) rather than deleting it — spec §2.3 ("cancelled updates its meeting") over the plan's "delete"; a full read's sweep leaves cancelled meetings alone, as Google leaves cancelled events out of a full read — cost if wrong: one delete instead of an update
- **Task 5:** Ruling: an all-day event is never a meeting (holidays, days out); a lead meeting has a time — cost if wrong: an all-day "site visit" with a lead isn't shown
- **Task 5:** Ruling: once a day a calendar is read in full again (besides a 410), so an event finds a lead whose email arrived after it was read (Review Focus "matched at the next full read") — cost if wrong: one extra full read a day per calendar
- **Task 5:** Ruling: only the addresses a read saw are looked up among live leads (email = ANY, citext), the oldest lead when two share an address — never every lead's email loaded — cost if wrong: none
- **Task 5:** Ruling: a meeting someone attached to a lead keeps that lead while the rules find none (COALESCE on update); the rules' own lead wins when they find one — cost if wrong: one expression
- **Task 5:** Ruling: two syncs of one connection: a session advisory lock on a pool connection held for the sync; the second says "busy" and does nothing. The calendars are re-checked under FOR UPDATE before writing: if the person chose others meanwhile, the read is dropped and the connection is due again at once — cost if wrong: one more read
- **Task 5:** Ruling: Google refusing the grant tells the person and every admin (owner or settings.manage) once, on the change to needs_reconnect, with a new notification kind `calendar_reconnect` — system_alert would offer "Open System health", wrong for a person's own calendar; until Task 7 it shows as a plain note — cost if wrong: Task 7 adds its "Connect again" action
- **Task 5:** Ruling: the tick asks for a due connection once and not again for five minutes (an in-process memory, as the sync itself also takes its lock) — cost if wrong: a duplicate read after an API restart
- **Task 5:** Ruling: DB_JOB_POOL_MAX defaults to 14 (was 10): two calendar workers each hold their lock connection and one for writing — cost if wrong: four more idle connections allowed
- **Task 6:** Ruling: calendar.view's scope says whose meetings the Calendar lists (the meeting's owner: own, their team's, everyone's); row-level security still shows a linked meeting only with a lead they may see, and an unlinked one only to its owner — cost if wrong: a filter on the lead's owner instead
- **Task 6:** Ruling: a lead's meetings (the drawer) are every meeting with that lead, whoever's calendar it's on, for anyone with calendar.view who may see the lead — cost if wrong: one more owner filter
- **Task 6:** Ruling: an outcome (completed / no-show / rescheduled, with a note) is recorded once, only after the meeting started, by its owner or someone whose calendar.view covers its owner; changing it later is refused (OUTCOME_RECORDED), as Phase 7's analytics will count it — cost if wrong: an edit path later. The "next step" of Log outcome is the existing follow-up flow, offered by Task 7's screen
- **Task 6:** Ruling: only a meeting with a lead that ended in the last 24 hours asks its owner (once, outcome_asked_at; migration 0037), so a first connect's 30 days of past meetings never floods anyone; unlinked meetings aren't asked (a follow-up needs a lead); the follow-up is "Log outcome: <title>", due at once, a LUME rule (LOG_OUTCOME_RULE_ID), from the follow-up clock every fifth minute; recording the outcome completes it — cost if wrong: older meetings need an outcome by hand
- **Task 6:** Ruling: attaching works only on an unlinked meeting (MEETING_LINKED otherwise); moving a meeting between leads isn't offered — cost if wrong: a second path later
- **Final:** Ruling: declined-to-judge — whether real Google returns nextSyncToken on a timeMin/timeMax read, and whether recurring series expand within the 10,000-event cap: only the fake can answer here; the owner's real-Google check before release covers it — cost if wrong: every sync fails with "Google gave no sync token" until a fix
- **Final:** Ruling: declined-to-judge — an event the person or the lead declined still counts as a meeting (the spec is silent); a person who declined usually deletes it, which Google reports as cancelled — cost if wrong: one condition on responseStatus

Deferred minors (3):

- a write that fails (a database error) skips failed(): no failures/last_error/backoff, so it re-reads Google every 5 minutes and the person sees nothing wrong (sync.ts write path)
- one failing or oversized shared calendar stops all of a person's calendars with the generic "LUME couldn't read this calendar." (readCalendars is all-or-nothing; a per-calendar 403 is treated as the grant's)
- if the advisory unlock fails, lock.release() returns a connection that may still hold the session lock; release(true) would destroy it

