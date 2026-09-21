#!/usr/bin/env bash
# Dump the LUME database (as lume_readonly_backup), encrypt it to every age recipient, upload it off-site.
# Report §12.7. Called by the worker's ops.backup job.
set -euo pipefail
: "${DATABASE_URL_BACKUP:?}" "${BACKUP_AGE_RECIPIENTS:?}" "${RCLONE_REMOTE:?}" "${BACKUP_NAME:?}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

recipients=()
IFS=',' read -ra keys <<<"$BACKUP_AGE_RECIPIENTS"
for k in "${keys[@]}"; do
  k="${k//[[:space:]]/}"
  [ -n "$k" ] && recipients+=(-r "$k")
done
[ "${#recipients[@]}" -ge 4 ] || { echo '{"ok":false,"error":"need two age recipients"}'; exit 1; }

pg_dump --format=custom --compress=6 --dbname="$DATABASE_URL_BACKUP" | age "${recipients[@]}" -o "$work/$BACKUP_NAME"
bytes="$(stat -c %s "$work/$BACKUP_NAME")"
rclone copyto --no-traverse "$work/$BACKUP_NAME" "$RCLONE_REMOTE/$BACKUP_NAME"
printf '{"backup":"%s","bytes":%s}\n' "$BACKUP_NAME" "$bytes"
