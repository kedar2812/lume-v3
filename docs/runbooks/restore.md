# Restore runbook

**Objectives (report §12.7):** RPO ≤ 6 hours (backups every 6 h), RTO ≤ 2 hours.

## What exists
- Off-site: `lume-YYYYMMDDTHHMMZ.dump.age` in the rclone remote `offsite` (7 days of 6-hourly, 4 weekly, 6 monthly).
- WhatsApp's files (2026-10-19): `files/<name>.age` in the same remote, each sent once after the dump that first points
  at it. Names are `HMAC(settings.files_salt, hash)`, so the names don't say what a file is. A file gone from the server
  stays off-site 200 days (longer than the oldest kept dump), then goes. System health says so when files haven't
  reached the backup for a day.
- **The default remote is a volume on the same server** (`RCLONE_CONFIG_OFFSITE_TYPE=local`). That's no protection
  against losing the server, and its copies fill the same disk the storage meter watches. Point `offsite` at a real
  remote (a bucket) for every client.
- Each file is encrypted to two age keys: the owner's **offline key** (kept off the server) and the server's restore-test key.
- Hostinger weekly snapshots as a second layer.
- Every Monday 04:00 UTC the worker restores the newest backup into a scratch database; results are in `ops_restore_tests`.

## Restore onto a new server (≈ 60–90 min)
1. Provision Ubuntu 24.04, run `infra/scripts/bootstrap-server.sh --deploy-key "<key>"`.
2. Put `.env` (from the password manager) and `secrets/restore.agekey` in `/opt/lume`, then `docker compose pull`.
3. Start only the database: `docker compose up -d db` (roles are created on first boot).
4. Fetch the newest backup with the worker image, which ships rclone and age (the host has neither):
   `docker compose run --rm --no-deps -v /tmp/lume-restore:/work worker sh -c 'rclone lsf "$RCLONE_REMOTE" | sort | tail -n 1'` to find the name, then
   `docker compose run --rm --no-deps -v /tmp/lume-restore:/work worker sh -c 'rclone copyto "$RCLONE_REMOTE/<name>" /work/b.age'`
   (or download it from the bucket UI into `/tmp/lume-restore/b.age`).
5. Decrypt on the server with the offline key streamed over SSH stdin, so the key never lands on disk:
   `ssh lume-deploy@server 'cd /opt/lume && docker compose run --rm -T --no-deps -v /tmp/lume-restore:/work worker sh -c "age -d -i /dev/stdin -o /work/b.dump /work/b.age"' < offline.agekey`
6. Restore as the owner role:
   `docker compose exec -T -u postgres db pg_restore --clean --if-exists --no-owner --role=lume_owner -d lume < /tmp/lume-restore/b.dump`
7. **WhatsApp's files** (only if WhatsApp was on). They're off-site on their own, not in the dump. Bring them back
   into the `files` volume with the restore-test key (`secrets/restore.agekey`):
   `docker compose run --rm --no-deps -v lume_files:/restore-files -e FILES_DIR=/restore-files -e AGE_IDENTITY_FILE=/run/secrets/restore_agekey worker /app/scripts/restore-files.sh`.
   It prints `{"restored":…,"already":…,"unreadable":…}` and is safe to run again. A file LUME no longer points at
   is cleared by the API's daily scan. Any message whose file didn't come back says so on the lead ("This file
   isn't on the server any more. It's still on the phone.").
8. `docker compose run --rm migrate` (a no-op if the schema is current), then `docker compose up -d`.
9. Verify: `https://<host>/readyz` is 200, spot-check lead counts, then `shred -u /tmp/lume-restore/b.dump /tmp/lume-restore/b.age`.
10. Record the incident and the restored backup's timestamp (data after it is lost, at most 6 h).

## Proved on the dev stack (Phase 9, 2026-10-06)
- The worker's weekly restore test ran on Monday 2026-10-05 04:00 UTC: `lume-20261005T0000Z.dump.age` fetched from
  the off-site remote, decrypted, restored into a scratch database — ok, 100 tables, 64 migrations (`ops_restore_tests`).
- A manual round trip inside the database container: `pg_dump -Fc` (17 MB) → `pg_restore --no-owner` into a scratch
  database → every public table's row count compared: 79 tables, 236,779 rows, identical table by table; 64
  migrations; no restore warnings; scratch database and dump removed. Only counts were read.
