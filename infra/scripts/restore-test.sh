#!/usr/bin/env bash
# Weekly restore test (report §12.7): fetch the newest backup, decrypt with the restore-test key,
# restore into a scratch database as lume_restore, run sanity counts, drop the scratch database.
set -euo pipefail
: "${DATABASE_URL_RESTORE:?}" "${BACKUP_AGE_IDENTITY_FILE:?}" "${RCLONE_REMOTE:?}"

fail() { printf '{"ok":false,"backup":"%s","error":"%s"}\n' "${latest:-}" "$1"; exit 1; }

base="${DATABASE_URL_RESTORE%/*}"
scratch="lume_restore_test_$(date -u +%Y%m%d%H%M%S)"
work="$(mktemp -d)"
cleanup() {
  psql -q -X "$base/postgres" -c "DROP DATABASE IF EXISTS $scratch WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

latest="$(rclone lsf --files-only "$RCLONE_REMOTE" 2>/dev/null | grep -E '^lume-[0-9]{8}T[0-9]{4}Z\.dump\.age$' | sort | tail -n 1 || true)"
[ -n "$latest" ] || fail "no backups found"

rclone copyto "$RCLONE_REMOTE/$latest" "$work/backup.age" || fail "download failed"
age -d -i "$BACKUP_AGE_IDENTITY_FILE" -o "$work/backup.dump" "$work/backup.age" || fail "decrypt failed"
psql -q -X -v ON_ERROR_STOP=1 "$base/postgres" -c "CREATE DATABASE $scratch" >/dev/null || fail "createdb failed"
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$base/$scratch" "$work/backup.dump" >/dev/null 2>"$work/restore.err" \
  || fail "pg_restore failed: $(head -c 200 "$work/restore.err" | tr '"\n' "' ")"

migrations="$(psql -X -At "$base/$scratch" -c "SELECT count(*) FROM schema_migrations")"
tables="$(psql -X -At "$base/$scratch" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema IN ('public','pgboss')")"
if [ "$migrations" -lt 1 ] || [ "$tables" -lt 3 ]; then
  fail "sanity counts failed (migrations=$migrations tables=$tables)"
fi

# WhatsApp's files (2026-10-19): one at random, from the files that go off-site on their own, downloads and decrypts
# with the restore-test key (age refuses anything tampered with).
files="none"
pick="$(rclone lsf --files-only "$RCLONE_REMOTE/files" 2>/dev/null | grep -E '^[0-9a-f]{64}\.age$' | shuf -n 1 || true)"
if [ -n "$pick" ]; then
  rclone copyto "$RCLONE_REMOTE/files/$pick" "$work/file.age" || fail "a WhatsApp file didn't download"
  age -d -i "$BACKUP_AGE_IDENTITY_FILE" -o "$work/file" "$work/file.age" || fail "a WhatsApp file didn't decrypt"
  files="checked"
fi

printf '{"ok":true,"backup":"%s","migrations":%s,"tables":%s,"files":"%s"}\n' "$latest" "$migrations" "$tables" "$files"
