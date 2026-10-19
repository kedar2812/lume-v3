# WhatsApp files: stored once, backed up once — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** WhatsApp photos, voice notes, videos and documents stop filling the database and every backup. Each file
is stored once on disk, named by its content, and goes off-site once, encrypted. Admins see how full the server is
and are told before it fills. A client can choose to keep files for a number of months.

**Architecture:**
- Files live on a `files` volume at `/var/lib/lume/files/<aa>/<sha256>`, written by the API.
- `whatsapp_files` (hash, size, last used) is the list of what's there; `whatsapp_media.sha256` points at it
  instead of the old `data` bytea.
- An hourly sweep:
  - drops files past the client's "keep for" window (`status = 'removed'`);
  - deletes files nothing points to, recording each in `whatsapp_files_gone`.
- The worker mounts the volume read-only. After each database backup it uploads the files the remote doesn't have
  (`files/<sha>.age`, encrypted to the same age keys).
- The worker deletes a remote file 200 days after it was gone from the server, which is longer than the oldest
  kept backup (6 monthly).

**Tech Stack:** Fastify + Drizzle + Postgres, pg-boss, Next.js, Vitest, Playwright, bash + age + rclone.

**Spec:** owner's ruling 2026-10-19, approving the 4 suggestions:
1. Store a file once.
2. Files out of the database, and an incremental file backup.
3. A storage meter and alert.
4. An optional "keep files for N months", off by default.

The base is spec 2026-10-18 §4.1 (media kept on the client's own server, 25 MB cap).

## Global Constraints

- **Lead data stays on the client's server.** Files go off-site only into the client's own backup remote, age-encrypted, like the dumps.
- **No client names.** Every limit is a setting or an env var with a default.
- **Copy rules:** speak as "LUME", no em dashes in UI copy, months first in dates.
- **The default keeps files forever.** The option is 3, 6, 12 or 24 months.
- **The disk alert** fires at 85% used or more. It goes through System health's existing once-a-day alert to admins, in the app and by email.

## Every outcome, and its fix (owner, 2026-10-19: "every problem acknowledged and a fix cooked", security included)

Each line is built and tested in the task named in brackets.

**Writing files**
1. **The same file arrives twice at once.** Fix: it's written to a temp name opened exclusively (`wx`), then renamed, so the content-named file is always whole. Both rows point at one file. [T1 test]
2. **The disk is full during a write (ENOSPC).** Fix: the temp file is removed. The row stays `waiting` with the words "The server's disk is full. LUME will try again." and `retry_at = now() + 15 min`, so its tries aren't burnt and the sweep doesn't hammer Meta. [T2 test]
3. **The disk is nearly full (95% used or more) before a fetch.** Fix: the fetch is skipped with the same words and `retry_at`. Postgres must never be the one that runs out of room. [T2 test]
4. **The files folder isn't writable** (an old compose without the volume, so the root is read-only: EROFS or EACCES). Fix: the row stays waiting with `retry_at` and the words "LUME can't save files on this server yet." System health shows "LUME can't write WhatsApp files on this server. Check the files volume." [T2, T3 tests]
5. **A crash leaves a temp file.** Fix: the daily disk scan deletes temp files older than an hour. [T2 test]
6. **A files row exists but no file was written** (a crash between the two). Fix: no media row points at it (`refs = 0`), so the sweep removes it after an hour. [T2 test]
7. **A file is on disk with no row** (an unlink failed after the row went). Fix: the daily disk scan removes files with no row that are over an hour old. [T2 test]

**Which files are in use**
8. **Row-level security hides some media rows from lume_app** (soft-deleted leads, people). A "nothing points to it" query could then wrongly see a file as unused. Fix: `whatsapp_files.refs` is kept by a trigger on `whatsapp_media` (insert, update of `sha256`, delete, including cascades). The sweep reads `refs`, never a query under RLS. The FK (`ON DELETE RESTRICT`) is a second guard. [T1 test]
9. **The sweep against a fetch in flight.** Fix: the fetch sets `last_ref_at = now()` before writing, and the sweep spares anything touched within the hour. [T2 test]
10. **Two API processes sweep at once.** Fix: `pg_try_advisory_xact_lock`. The second one skips. [T2 test]
11. **A lead is deleted** (cascade) **or a stranger is cleared after 14 days.** Fix: the trigger counts down and the sweep removes the file only when no other lead still uses it. [T2 test]
12. **"Make it an enquiry"** moves a stranger's media to a lead. Fix: `sha256` doesn't change, so neither does the count. [T2 test]

**Serving files**
13. **The file is missing on disk** (a restored database without its files). Fix: the info route says `missing` with the words "This file isn't on the server any more. It's still on the phone." The file route gives 404 `MEDIA_MISSING`. The thread shows the words. [T2, T5 tests]
14. **Video and voice notes need seeking (Safari plays nothing without Range).** Fix: one byte range gets 206 and `Content-Range`. A bad or multiple range gets 416. With no Range, the whole file. [T2 test]
15. **Repeat views.** Fix: `ETag` is the file's hash and `If-None-Match` gives 304, with `cache-control: private`. [T2 test]

**Keep files for N months**
16. **The window is shortened.** Fix: the confirm sheet says how many files go, and "They stay on the phone. Files removed don't come back." It's applied within the hour. [T2, T5 tests]
17. **The window is lengthened, or set back to forever, after removal.** Fix: the words say removed files don't come back. Meta's links expire after 30 days, so LUME can't fetch them again. [T5 copy]
18. **An old copy and a recent copy of the same file.** Fix: only the old row is cleared. The file stays while the recent row points at it. [T2 test]
19. **Turning WhatsApp off, then on again.** Fix: the setting merges, so "keep for" survives the switch. [T2 test]

**Backups**
20. **The first upload is large** (gigabytes) **and the job would run out of time.** Fix: `ops.backup` gets `expireInSeconds: 3600`, and the file sync has a 30-minute budget per run. It goes on in the next run and reports what's left. [T4 test]
21. **The remote has no `files/` folder yet.** Fix: rclone's "directory not found" (exit 3) counts as empty. Any other error fails the file sync. [T4 test]
22. **The file sync fails while the dump succeeded.** Fix: the dump stays. The result goes in `ops_events` (`backup.files`). System health says "WhatsApp files haven't reached the backup for over a day" when there are files and no successful sync in 24 hours. [T3, T4 tests]
23. **A half-uploaded file.** Fix: it's encrypted to a temp file, then `rclone copyto`, which checks size and hash where the remote can. [T4]
24. **A file is gone from the server but older dumps still point at it.** Fix: the remote copy is kept 200 days after it went (the oldest kept dump is about 186 days old), then deleted. [T4 test]
25. **A file comes back** (the same brochure again) **after it went.** Fix: its gone record is cleared. If the worker had already deleted the remote copy, the next sync uploads it again. [T2, T4 tests]
26. **The backup goes to the default local `offsite` volume on the same disk.** Fix: the runbook says so plainly, and the disk meter counts it, since it's on the same disk. A real off-site remote is the recommendation. [T4 docs]
27. **Restore.** Fix: `restore-files.sh` decrypts every `files/*.age`, checks its hash, and writes `<aa>/<hash>`. A mismatch is skipped and reported. The weekly restore test decrypts one file and checks its hash. [T4 test]
28. **No files folder** (the demo, an old compose). Fix: the sync reports 0 files and the backup still succeeds. [T4 test]

**Disk meter**
29. **statfs fails, or the platform has none.** Fix: `null`, shown as "not known", with no alarm. [T3 test]
30. **`pg_database_size` is refused.** Fix: `null`, and the rest of the health page still loads. [T3 test]
31. **The alert says the same thing all day.** Fix: the existing once-a-business-day claim per problem key. [existing]

**Security**
32. **A stranger sends an HTML, SVG or XML "document".** Served inline on LUME's own origin, that would be stored XSS. Fix: inline only for an allow-list of raster image, audio and video types (jpeg, png, webp, gif, mp4, 3gpp, ogg, mpeg, aac, amr). Everything else is an attachment with `content-type: application/octet-stream` when it isn't allow-listed. Every file gets `Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`. [T2 test]
33. **The path comes from a hash.** Fix: only `^[0-9a-f]{64}$` is accepted. There's no route by hash: files are reached only through a media id that row-level security lets the person see. [T1, T2 tests]
34. **The token would go to a host that isn't Meta's.** Fix: downloads follow only https URLs on Meta's media hosts (`*.fbsbx.com`, `*.facebook.com`, `*.whatsapp.net`), or the configured graph host in tests. Redirects aren't followed off those hosts. [T2 test]
35. **Strangers flood LUME with files** to fill the disk. Fix: files from numbers no lead has are capped at 1 GB a day. Over it, the row says "LUME didn't keep this file. Too many files came today from people who aren't leads." The 95% guard (3) backs it up. [T2 test]
36. **The off-site copy's names give away its contents** (a raw hash lets anyone holding a candidate file confirm the client had it). Fix: remote names are `HMAC-SHA256(key derived from LUME_MASTER_KEY, hash)`. A restore needs no name map, because the decrypted file's own hash is its name. [T4 test]
37. **Off-site files are tampered with.** Fix: a restore checks every decrypted file's hash against its name and skips any that don't match. The database only points at hashes, so a forged file can't take one's place. [T4 test]
38. **File permissions on the server.** Fix: files are 0640 and folders 0750, owned by `node`. The worker mounts them read-only. [T1, T4]
39. **Malware in a document.** Fix: LUME never opens, renders or runs a document. It's a download only, with `nosniff` and a sandboxing CSP. The runbook notes there's no antivirus scan. [T2]
40. **Who can change "keep for" or see the preview.** Fix: Settings manage only, and in the audit log. The access matrix gets the new route. [T2 test]
41. **Logs.** Fix: no token, media URL or file name is ever logged. Errors log the media id only. [T2 review]

**Migration**
42. **Rows already holding `data`** (dev only, since no Meta app exists, so no client has any). Ruling: they become `failed` with the words "Fetched before an update. It's still on the phone." Cost if wrong: one photo per test row. [T1]

## Review Focus

- **The same file twice at once** (two leads get the brochure in one second): stored once, both rows point at it, and nothing is lost.
- **The sweep against a fetch in flight:** a file is never deleted between being written and its row pointing at it. The files row is touched before the write, and the sweep spares anything touched within the hour.
- **A file on disk going missing** (restored DB, no files yet): the thread says "This file isn't on the server any more" and doesn't error.
- **Turning "keep for" on with old files:** the next sweep removes them, the rows stay as "removed" with words, and the messages stay.
- **Backup with no files directory** (old compose, demo): the backup still succeeds and reports 0 files.

---

### Task 1: The file store and the table

**Files:** create `apps/api/src/modules/whatsapp/files.ts` (+ test), `packages/db/migrations/0074_whatsapp_files.sql`; modify `packages/db/src/schema/whatsapp.ts`.

- `fileStore(root): { put(bytes): Promise<{ sha256: string; size: number }>; path(sha): string; exists(sha): Promise<boolean>; remove(sha): Promise<void> }`. It writes to `<root>/<aa>/.<sha>.<rand>` and then renames, so the write is atomic, and skips files already there. `path` refuses anything that isn't 64 hex characters.
- **Migration:**
  - `whatsapp_files (sha256 text PK CHECK hex64, size bigint NOT NULL, last_ref_at timestamptz NOT NULL DEFAULT now(), created_at)`.
  - `whatsapp_files_gone (sha256 text PK, gone_at timestamptz NOT NULL DEFAULT now())`.
  - `whatsapp_media`:
    - add `sha256 text REFERENCES whatsapp_files ON DELETE RESTRICT`;
    - rows that were ready become `failed` with words;
    - drop `data`;
    - status adds `removed`;
    - `CHECK ((status = 'ready') = (sha256 IS NOT NULL))`;
    - index on `sha256`.
- **Tests:**
  - put twice → one file, same hash;
  - concurrent puts of the same bytes → one file;
  - `path("../x")` throws;
  - remove of a missing file is fine.

### Task 2: Fetch, serve, keep-for setting, and the sweep

**Files:** modify `media.ts`, `queue.ts`, `inbox.ts` (sweep), `service.ts` + `routes.ts` (setting), `app.ts` (`AppDeps.files`), `main.ts`, `test/harness.ts`, `packages/config/src/schema.ts` (`LUME_FILES_DIR`, default `/var/lib/lume/files`).

- **`fetchMedia`:**
  - upsert `whatsapp_files` (`last_ref_at = now()`) and clear `whatsapp_files_gone` for that hash first;
  - then `store.put`;
  - then the media row gets `sha256` and `size`.
- **`sendMedia`:** streams from disk with `content-length`. A missing file gives 404 with `MEDIA_MISSING`, "This file isn't on the server any more."
- **`PUT /api/v1/integrations/whatsapp`:**
  - body `{ enabled?: boolean, keepFilesMonths?: 3|6|12|24|null }`, at least one of them;
  - merges into `integrations.whatsapp`;
  - the integrations view returns `keepFilesMonths`.
- **`sweepWhatsAppFiles(pool, store)`, hourly after `sweepWhatsApp`:**
  - with keep-for set, ready media older than N months → `removed`, `sha256 NULL`, words "LUME keeps WhatsApp files for N months. This one is still on the phone.";
  - then delete `whatsapp_files` rows nothing points to and untouched for 1 hour (FK-safe), insert them into gone, and unlink them.
- **Tests:** in `media.test.ts` / new `files.test.ts`:
  - two leads with the same bytes → one row in `whatsapp_files`, one file on disk;
  - served bytes equal;
  - a missing file on disk → 404 words;
  - keep-for 3 months → the old file removed, a fresh one kept, the orphan file deleted and recorded gone;
  - a file touched within the hour is kept;
  - the setting validates and merges (enabled survives a keep-for change).

### Task 3: Storage meter and alert

**Files:** modify `apps/api/src/modules/health/{service,routes}.ts` (+ test), `main.ts` (pass `disk`), web `lib/settings/health.ts`, `SystemHealth.tsx`.

- `Health.storage = { diskTotal: number|null, diskFree: number|null, database: number, whatsappFiles: number }`. The disk figures come from `fs.statfs(filesDir)`; the database from `pg_database_size`; files from `sum(size)` over `whatsapp_files`.
- **The problem** `disk_full`, at 85% used or more: "The server's disk is 91% full (8.2 GB left). Keep WhatsApp files for fewer months in Integrations, or move LUME to a bigger server."
- **The UI:**
  - a **Storage** card: a bar of disk used, and the lines "Database 1.2 GB", "WhatsApp files 640 MB", "Free 61 GB";
  - it warns at 85% or more.
- **Tests:**
  - the health test gets a fake disk at 90%, which gives the problem with those words;
  - at 50%, no problem;
  - with no disk reading, `null` and no problem.

### Task 4: Off-site files, restore, compose

**Files:**
- create `infra/scripts/backup-files.sh`;
- modify `apps/worker/src/{ops,main}.ts` (+ `ops.test.ts`), `infra/docker-compose.yml` (`files` volume: api rw, worker ro, env), `infra/docker/{api,worker}.Dockerfile` (dirs owned by node; copy the script), `infra/scripts/restore-test.sh` (decrypt one file when any exist), `docs/runbooks/restore.md`, `docs/runbooks/whatsapp.md`.

- **`backup-files.sh`:**
  - env `FILES_DIR RCLONE_REMOTE BACKUP_AGE_RECIPIENTS`;
  - local hashes (`find -type f -name '[0-9a-f]*'`) minus remote `files/` names gives the ones missing;
  - each missing one: `age … | rclone rcat "$RCLONE_REMOTE/files/<sha>.age"`;
  - prints `{"files":n,"bytes":b}`;
  - with no directory: `{"files":0,"bytes":0}`.
- **`ops.backup()`:**
  - after the dump, runs `backup-files.sh`;
  - then for `goneFiles(olderThanDays = 200)` from the DB: `rclone deletefile …/files/<sha>.age`, then `forgetGone(sha)`;
  - the result adds `files` and `filesBytes`.
- **Test in `ops.test.ts`:**
  - the exec sequence: dump, then files, then deletefile for gone hashes;
  - `forgetGone` is called only after the delete succeeded.

### Task 5: UI (the keep-for select, the thread's removed and missing states) and e2e

**Files:** modify `WhatsAppConnected.tsx`/`WhatsAppCard.tsx`, `lib/whatsapp/{types,client}.ts`, `WhatsAppThread.tsx`, `e2e/whatsapp.spec.ts`, `e2e/api-server.mjs` (`LUME_FILES_DIR` temp dir), and the canvas (one board added: Storage).

- **The card:** a "Keep WhatsApp files" select with Forever / 24 / 12 / 6 / 3 months, and the line "Older files go from LUME. They stay on the phone." Admins only, saved at once with a toast.
- **The thread:** the `removed` and `failed` states show their words in place of the file.
- **E2E:**
  - the existing photo test still passes (now from disk);
  - System health shows the Storage card;
  - screenshots in both themes.

## Rulings made while building (2026-10-19)

- **Off-site names use a salt in the database (`settings.files_salt`), not a key derived from `LUME_MASTER_KEY`.** A master-key rotation would otherwise rename every off-site copy (orphans that are never pruned). The salt comes back with any restore. Cost if wrong: names are as private as the database, which already holds every hash.
- **The off-site copy is TypeScript in the worker (`files-offsite.ts`), not a bash script.** Every outcome is unit-tested with a fake `exec`, and the real `age`/`rclone` calls were proved in the worker image. Cost if wrong: none found.
- **A failed remote delete asks `lsf --include <name>` whether the file is still there.** rclone 1.60 exits 1 for a missing file too (checked in the worker image; I had assumed 4). Cost if wrong: one extra listing per failed delete.
- **Item 37 is narrowed.** A restore can't tell a tampered file from a stray by its name, since names are HMACs. It writes each file under its own content hash. The database points only at hashes, so a forged file is never used, and the daily scan clears it. age's own authentication refuses ciphertext that was tampered with.
- **Scale (owner, 2026-10-19: "100 or 1000 people"):**
  - the strangers' cap is per connected number;
  - the hourly sweep works in batches of 1,000, each its own transaction, within 5 minutes, under one session lock;
  - the daily scan goes one of the 256 folders at a time;
  - four media fetchers.
- **The "whose number" picker on the WhatsApp card is still a native select.** It's fine with type-ahead up to a few hundred people. A searchable people picker across LUME belongs in the 1,000-person audit, not here.
- **Leads are only ever soft-deleted.** Their files stay while the lead is in the bin, and "keep for" covers them too (scope 'all' sees deleted leads).
- **The canvas wasn't updated for the two small additions** (the "Keep WhatsApp files" row, the Storage card). The session's account changed, and the canvas belongs to the owner's other account. The screenshots in `e2e/__review__` stand in for it.
