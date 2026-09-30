#!/usr/bin/env bash
# Bring up LUME for a client (licensing L-C; the source spec §3.4). Idempotent: every step checks before it
# acts, and a second run changes nothing. No source code goes to the server: the pinned images, the compose
# file, Caddy's and Postgres's configuration, and .env (mode 600).
#
#   scripts/provision.sh <slug> [--version X.Y.Z] [--dry-run]
#
# Before it: the client is in deploy/clients.yml (status: new), <slug>.lumecrm.in points at its server, the
# server has the sudo user lume-deploy with LUME's SSH key, and deploy/clients/<slug>.env has the inputs:
#   LUME_LICENSE_KEY=…      (New licence on license.lumecrm.in; the instance ID is in clients.yml)
#   GHCR_USER=… GHCR_TOKEN=…  (this client's own read-only registry token)
#   OWNER_AGE_RECIPIENT=age1… (the owner's offline backup key)
#   SMTP_URL=… MAIL_FROM=…  (optional)
set -euo pipefail
# shellcheck source=scripts/fleet/lib.sh
. "$(dirname "$0")/fleet/lib.sh"

CLIENTS_DIR="${LUME_CLIENTS_DIR:-$FLEET_ROOT/deploy/clients}"
DOMAIN="${LUME_DOMAIN:-lumecrm.in}"
REGISTRY="${LUME_REGISTRY:-ghcr.io/kedar2812/lume-v3}"
WAIT="${LUME_WAIT_SECONDS:-5}"
TRIES="${LUME_HEALTH_TRIES:-36}"

parse_dry "$@"
set -- "${ARGS[@]}"
slug="${1:?usage: provision.sh <slug> [--version X.Y.Z] [--dry-run]}"
shift
version=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="${2:?}"; shift ;;
    *) die "unknown option $1" ;;
  esac
  shift
done

# ---------- what we know before touching anything ----------
target "$slug"
status="$(inv get "$slug" status)"
[ "$status" != decommissioned ] || die "$slug is decommissioned: provision a new slug instead"
if [ -z "$version" ]; then
  version="$(inv get "$slug" version)"
  # Read with the repository as the working directory: Windows' node can't open a /f/… path.
  [ "$version" != none ] && [ -n "$version" ] || version="$(cd "$FLEET_ROOT" && node -p "require('./package.json').version")"
fi
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "the version must be X.Y.Z (never latest), got '$version'"
running="$(inv get "$slug" version)"
if [ "$status" = active ] && [[ "$running" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && [ "$running" != "$version" ] &&
  [ "$(printf '%s\n%s\n' "$running" "$version" | sort -V | head -n 1)" = "$version" ]; then
  die "refusing: $version is older than the $running it runs (update.sh is how versions move)"
fi
instance="$(inv get "$slug" instance)"
[ -n "$instance" ] || die "$slug has no instance in clients.yml (New licence on the licence server gives it)"

inputs="$CLIENTS_DIR/$slug.env"
[ -f "$inputs" ] || die "no $inputs: put the client's inputs there first (see the top of this script)"
# The last value for a key, with any Windows line end (\r) taken off.
envget() { sed -n "s/^$1=//p" "$inputs" | tail -n 1 | tr -d '\r'; }
for key in LUME_LICENSE_KEY GHCR_USER GHCR_TOKEN OWNER_AGE_RECIPIENT; do
  [ -n "$(envget "$key")" ] || die "$inputs has no $key"
done
host_name="$slug.$DOMAIN"
image="$REGISTRY/worker:$version"

# ---------- 1. DNS ----------
step "DNS: $host_name → $HOST"
if ! $DRY; then
  if command -v dig >/dev/null 2>&1; then
    points="$(dig +short "$host_name" | tail -n 1)"
  else # Git Bash on Windows has no dig: ask through node.
    points="$(node -e 'require("dns").promises.resolve4(process.argv[1]).then((a) => console.log(a.at(-1) ?? ""), () => console.log(""))' "$host_name")"
  fi
  [ "$points" = "$HOST" ] || die "$host_name points at ${points:-nothing}, not $HOST: add the A record first"
fi

# ---------- 2. secrets, made once ----------
step "secrets (kept in $inputs; never regenerated)"
secret() { # secret <KEY> <command>
  if grep -q "^$1=" "$inputs"; then return; fi
  if $DRY; then printf '[dry-run] generate %s\n' "$1"; return; fi
  local value
  value="$($2)" || die "couldn't generate $1 (openssl)"
  [ -n "$value" ] || die "couldn't generate $1 (empty)"
  printf '%s=%s\n' "$1" "$value" >> "$inputs"
}
hex() { openssl rand -hex 24; }
b64() { openssl rand -base64 32; }
( umask 077; touch "$inputs" )
chmod 600 "$inputs"
# A file saved without a last newline would glue the first secret onto its last line.
if ! $DRY && [ -s "$inputs" ] && [ -n "$(tail -c 1 "$inputs")" ]; then echo >> "$inputs"; fi
secret LUME_MASTER_KEY b64
for key in POSTGRES_SUPERUSER_PASSWORD LUME_OWNER_PASSWORD LUME_APP_PASSWORD LUME_WORKER_PASSWORD LUME_BACKUP_PASSWORD LUME_RESTORE_PASSWORD; do
  secret "$key" hex
done

# ---------- 3. harden the server (idempotent itself) ----------
step "sudo: lume-deploy needs it without a password (every step below uses it)"
remote "sudo -n true" || die "lume-deploy needs passwordless sudo on $HOST: add /etc/sudoers.d/lume-deploy with 'lume-deploy ALL=(ALL) NOPASSWD:ALL' (docs/runbooks/fleet.md)"
step "harden: user lume-deploy, SSH keys only, ufw 22/80/443, unattended upgrades, Docker"
upload "$FLEET_ROOT/infra/scripts/bootstrap-server.sh" /tmp/lume-bootstrap.sh
remote "sudo bash /tmp/lume-bootstrap.sh && rm -f /tmp/lume-bootstrap.sh"

# ---------- 4. /opt/lume: the compose file and configuration ----------
step "/opt/lume"
# /opt/lume is the deploy user's (750); Postgres's own user (uid 999) must read its config and init scripts.
remote "sudo install -d -m 750 -o $DEPLOY_USER -g $DEPLOY_USER /opt/lume && sudo install -d -m 755 -o $DEPLOY_USER -g $DEPLOY_USER /opt/lume/postgres /opt/lume/postgres/init"
upload "$FLEET_ROOT/infra/docker-compose.yml" /opt/lume/docker-compose.yml
upload "$FLEET_ROOT/infra/Caddyfile" /opt/lume/Caddyfile
upload "$FLEET_ROOT/infra/postgres/postgresql.conf" /opt/lume/postgres/postgresql.conf
upload "$FLEET_ROOT/infra/postgres/pg_hba.conf" /opt/lume/postgres/pg_hba.conf
for f in "$FLEET_ROOT"/infra/postgres/init/*; do
  upload "$f" "/opt/lume/postgres/init/$(basename "$f")"
done

# ---------- 5. the registry, with this client's own read-only token (on stdin, never a command line) ----------
step "registry login"
remote_stdin "docker login ghcr.io -u $(envget GHCR_USER) --password-stdin" <<<"$(envget GHCR_TOKEN)"
# Pulled now, as the user who logged in: root (the key step below) has no registry login of its own.
remote "docker pull $image"

# ---------- 6. the restore-test key, made on the server once ----------
step "backup keys"
remote "sudo sh -c 'test -s /opt/lume/secrets/restore.agekey || docker run --rm --user 1000 -v /opt/lume/secrets:/s $image age-keygen -o /s/restore.agekey'"
restore_pub="age1restore-dry-run"
if ! $DRY; then
  restore_pub="$(remote "sudo docker run --rm -v /opt/lume/secrets:/s:ro $image age-keygen -y /s/restore.agekey" | tail -n 1)"
fi

# ---------- 7. .env (mode 600) ----------
step ".env"
rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT
# Single-quoted, so compose takes each value as it is (a "$" in an SMTP password stays a "$").
kv() {
  case "$2" in *"'"*) die "$1 contains a single quote, which .env can't hold as it is" ;; esac
  printf "%s='%s'\n" "$1" "$2"
}
{
  echo "# Written by scripts/provision.sh for $slug. Secrets: keep this file mode 600."
  kv LUME_PUBLIC_HOST "$host_name"
  kv LUME_TLS ""
  kv LUME_IMAGE_PREFIX "$REGISTRY"
  kv LUME_TAG "$version"
  kv LUME_INSTANCE_ID "$instance"
  kv LUME_LICENSE_KEY "$(envget LUME_LICENSE_KEY)"
  for key in LUME_MASTER_KEY POSTGRES_SUPERUSER_PASSWORD LUME_OWNER_PASSWORD LUME_APP_PASSWORD LUME_WORKER_PASSWORD LUME_BACKUP_PASSWORD LUME_RESTORE_PASSWORD; do
    kv "$key" "$(envget "$key")"
  done
  kv BACKUP_AGE_RECIPIENTS "$(envget OWNER_AGE_RECIPIENT),$restore_pub"
  kv LUME_SECRETS_DIR /opt/lume/secrets
  # Off-site backups: from the client's inputs (never this shell), so a second run can't change them.
  offsite_type="$(envget RCLONE_CONFIG_OFFSITE_TYPE)"
  offsite_remote="$(envget RCLONE_REMOTE)"
  kv RCLONE_CONFIG_OFFSITE_TYPE "${offsite_type:-local}"
  kv RCLONE_REMOTE "${offsite_remote:-offsite:/var/lib/lume/offsite}"
  kv SMTP_URL "$(envget SMTP_URL)"
  kv MAIL_FROM "$(envget MAIL_FROM)"
  kv LOG_LEVEL info
} > "$rendered"
upload "$rendered" /opt/lume/.env
remote "chmod 600 /opt/lume/.env"

# ---------- 8. pull the pinned version, migrate, start ----------
step "LUME $version: pull, migrate, start"
remote "cd /opt/lume && docker compose pull"
remote "cd /opt/lume && docker compose run --rm migrate"
remote "cd /opt/lume && docker compose up -d"

# ---------- 9. health ----------
step "health: https://$host_name/healthz"
if ! $DRY; then
  up=false
  for _ in $(seq 1 "$TRIES"); do
    if curl -fsS --max-time 10 "https://$host_name/healthz" >/dev/null 2>&1; then up=true; break; fi
    sleep "$WAIT"
  done
  $up || die "$host_name didn't come up: see 'docker compose logs' on the server"
fi

# ---------- 10. the setup link, and the inventory ----------
step "setup"
if $DRY; then
  echo "[dry-run] print the setup link and token"
else
  token="$(remote "cd /opt/lume && docker compose logs api" | sed -n 's/.*first-run setup token: \([A-Za-z0-9_-]*\).*/\1/p' | tail -n 1)"
  if [ -n "$token" ]; then
    printf '\nLUME is up. The client finishes setup at https://%s/setup with this token:\n  %s\n' "$host_name" "$token"
  else
    printf '\nLUME is up at https://%s (already set up).\n' "$host_name"
  fi
  inv set "$slug" version "$version"
  inv set "$slug" status active
fi
echo "It checks in with license.lumecrm.in at start: its row there turns green."
