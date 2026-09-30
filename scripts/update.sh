#!/usr/bin/env bash
# Update LUME for one client or all of them (licensing L-C; the source spec §4). For each: back up first (the
# encrypted backup, and a plain dump kept on the server for this update), pull the new version, migrate,
# restart and check health. If health fails, go back to the previous version, and restore the pre-update
# dump if migrations ran. One client's failure never stops the others. A table says what happened.
#
#   scripts/update.sh <X.Y.Z> <slug|all> [--dry-run]
set -euo pipefail
# shellcheck source=scripts/fleet/lib.sh
. "$(dirname "$0")/fleet/lib.sh"

DOMAIN="${LUME_DOMAIN:-lumecrm.in}"
WAIT="${LUME_WAIT_SECONDS:-5}"
TRIES="${LUME_HEALTH_TRIES:-36}"

parse_dry "$@"
set -- "${ARGS[@]}"
version="${1:?usage: update.sh <X.Y.Z> <slug|all> [--dry-run]}"
which="${2:?usage: update.sh <X.Y.Z> <slug|all> [--dry-run]}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "the version must be X.Y.Z (never latest), got '$version'"
if [ "$which" = all ]; then mapfile -t slugs < <(inv list); else slugs=("$which"); fi
[ "${#slugs[@]}" -gt 0 ] || die "no clients to update"

table="$(mktemp)"
trap 'rm -f "$table"' EXIT

healthy() {
  $DRY && return 0
  for _ in $(seq 1 "$TRIES"); do
    curl -fsS --max-time 10 "https://$1/healthz" >/dev/null 2>&1 && return 0
    sleep "$WAIT"
  done
  return 1
}
set_tag() { remote "sed -i 's/^LUME_TAG=.*/LUME_TAG=$1/' /opt/lume/.env"; }

# One client, in its own subshell: prints its table row whatever happens, exits 1 if it isn't updated.
update_one() {
  local slug="$1" prev host_name out migrated=false restored=""
  target "$slug"
  prev="$(inv get "$slug" version)"
  host_name="$slug.$DOMAIN"
  result() { printf '%-24s %-10s %-10s %s\n' "$slug" "$prev" "$version" "$1" >> "$table"; }
  if [ "$prev" = "$version" ]; then result "already on it"; return 0; fi
  if ! [[ "$prev" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then result "not provisioned yet (version $prev)"; return 1; fi

  step "$slug: back up (encrypted, off-site as configured), and a dump for this update"
  if ! remote "cd /opt/lume && docker compose run --rm worker node dist/main.js run-now ops.backup" ||
    ! remote "mkdir -p /opt/lume/backups && cd /opt/lume && docker compose exec -T -u postgres db pg_dump -Fc lume > /opt/lume/backups/before-$version.dump"; then
    result "backup failed, nothing changed"
    return 1
  fi

  step "$slug: $prev → $version"
  set_tag "$version"
  if ! remote "cd /opt/lume && docker compose pull"; then
    set_tag "$prev" || true
    result "pull failed, still on $prev"
    return 1
  fi
  local migrate_ok=true
  out="$(remote "cd /opt/lume && docker compose run --rm migrate")" || migrate_ok=false
  [ -n "$out" ] && printf '%s\n' "$out"
  # Anything but a clean "nothing applied" counts as migrations having run (a restore is then needed).
  grep -q '"applied":\[\]' <<<"$out" || migrated=true
  if $migrate_ok && remote "cd /opt/lume && docker compose up -d" && healthy "$host_name"; then
    $DRY || inv set "$slug" version "$version"
    result "updated"
    return 0
  fi

  step "$slug: unhealthy on $version, rolling back to $prev"
  set_tag "$prev" || true
  if $migrated; then
    remote "cd /opt/lume && docker compose stop api worker web" || true
    if remote "cd /opt/lume && docker compose exec -T -u postgres db pg_restore -d lume --clean --if-exists < /opt/lume/backups/before-$version.dump"; then
      restored=", backup restored"
    else
      restored=", RESTORE FAILED (the dump is /opt/lume/backups/before-$version.dump)"
    fi
  fi
  remote "cd /opt/lume && docker compose up -d" || true
  if healthy "$host_name"; then
    result "rolled back to $prev$restored"
  else
    result "rolled back to $prev$restored, but NOT HEALTHY: look now"
  fi
  return 1
}

failed=0
for slug in "${slugs[@]}"; do
  ( update_one "$slug" ) || failed=1
done

printf '\n%-24s %-10s %-10s %s\n' "CLIENT" "FROM" "TO" "RESULT"
cat "$table"
exit "$failed"
