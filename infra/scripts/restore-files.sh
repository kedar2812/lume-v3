#!/usr/bin/env bash
# Bring WhatsApp's files back from the off-site copy (2026-10-19; docs/runbooks/restore.md). Every files/*.age is
# decrypted and written under its own content's hash: FILES_DIR/<first two>/<sha256>. The database only ever points
# at hashes, so a file that decrypts to anything else (tampered, or a stray) is never mistaken for one LUME expects;
# the API's daily scan clears files no row points to. Files already there are left as they are. Safe to run again.
#
#   docker compose run --rm --no-deps -v lume_files:/restore-files -e FILES_DIR=/restore-files \
#     -e AGE_IDENTITY_FILE=/run/secrets/restore_agekey worker /app/scripts/restore-files.sh
set -euo pipefail
: "${RCLONE_REMOTE:?}" "${FILES_DIR:?}" "${AGE_IDENTITY_FILE:?}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
restored=0
already=0
unreadable=0

listing="$work/listing"
if ! rclone lsf --files-only "$RCLONE_REMOTE/files" >"$listing" 2>"$work/lsf.err"; then
  # rclone says 3 for a folder that isn't there: nothing was ever sent.
  if grep -qi "directory not found" "$work/lsf.err"; then : >"$listing"; else
    printf '{"ok":false,"error":"couldn'"'"'t list the backup'"'"'s files"}\n'
    exit 1
  fi
fi

while IFS= read -r name; do
  [[ "$name" =~ ^[0-9a-f]{64}\.age$ ]] || continue
  if ! rclone copyto "$RCLONE_REMOTE/files/$name" "$work/f.age" 2>/dev/null \
    || ! age -d -i "$AGE_IDENTITY_FILE" -o "$work/f" "$work/f.age" 2>/dev/null; then
    unreadable=$((unreadable + 1))
    rm -f "$work/f" "$work/f.age"
    continue
  fi
  sha="$(sha256sum "$work/f" | cut -d' ' -f1)"
  dir="$FILES_DIR/${sha:0:2}"
  if [ -f "$dir/$sha" ]; then
    already=$((already + 1))
  else
    install -d -m 750 "$dir"
    # Into place through a temp name the API's scan knows, so a run cut short never leaves half a file under a hash.
    tmp="$dir/.tmp-restore-$$"
    mv "$work/f" "$tmp"
    chmod 640 "$tmp"
    mv -n "$tmp" "$dir/$sha"
    rm -f "$tmp"
    restored=$((restored + 1))
  fi
  rm -f "$work/f" "$work/f.age"
done <"$listing"

printf '{"ok":%s,"restored":%s,"already":%s,"unreadable":%s}\n' \
  "$([ "$unreadable" -eq 0 ] && echo true || echo false)" "$restored" "$already" "$unreadable"
