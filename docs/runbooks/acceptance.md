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
