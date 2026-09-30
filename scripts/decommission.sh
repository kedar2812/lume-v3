#!/usr/bin/env bash
# Remove LUME from a client's server, leaving nothing (licensing L-C; the source spec §6). Only for a client
# whose licence is suspended and who has confirmed they received their export.
#
#   scripts/decommission.sh <slug> --export-confirmed [--dry-run]
#
# Before it: Suspend the client on the licence server (its LUME picks that up at its next check), hand them
# Export all data, and get their written confirmation. After it: revoke the client's registry token and
# remove the DNS record (it says which), and mark the client decommissioned on the licence server.
set -euo pipefail
# shellcheck source=scripts/fleet/lib.sh
. "$(dirname "$0")/fleet/lib.sh"

CLIENTS_DIR="${LUME_CLIENTS_DIR:-$FLEET_ROOT/deploy/clients}"
DOMAIN="${LUME_DOMAIN:-lumecrm.in}"
REGISTRY="${LUME_REGISTRY:-ghcr.io/kedar2812/lume-v3}"

parse_dry "$@"
confirmed=false
rest=()
for a in "${ARGS[@]}"; do
  if [ "$a" = "--export-confirmed" ]; then confirmed=true; else rest+=("$a"); fi
done
slug="${rest[0]:?usage: decommission.sh <slug> --export-confirmed [--dry-run]}"
$confirmed || die "refusing: pass --export-confirmed once $slug has confirmed, in writing, that they received their export"
target "$slug"
inputs="$CLIENTS_DIR/$slug.env"
registry_user="$(sed -n 's/^GHCR_USER=//p' "$inputs" 2>/dev/null | tail -n 1)"

# ---------- the licence must say suspended (read from the installation's own stored answer) ----------
step "$slug's licence"
if $DRY; then
  echo "[dry-run] read the licence state LUME holds, and stop unless it's suspended"
else
  stored="$(remote "cd /opt/lume && docker compose exec -T -u postgres db psql -d lume -Atc 'SELECT token FROM licence_state'" | tail -n 1)"
  [ -n "$stored" ] || die "refusing: $slug holds no licence token, so it can't be shown to be suspended"
  state="$(node -e 'try { const p = JSON.parse(Buffer.from(process.argv[1].split(".")[0], "base64url").toString()); console.log(p.state ?? "unknown"); } catch { console.log("unreadable"); }' "$stored")"
  [ "$state" = suspended ] || die "refusing: $slug's licence is $state, not suspended (Suspend it on the licence server first)"
fi

# ---------- remove everything ----------
step "$slug: the stack, its images and volumes (the database, the off-site copies here), /opt/lume and its backups"
remote "cd /opt/lume && docker compose down --volumes --rmi all --remove-orphans"
# Every LUME image, not only the current version's: each update leaves the previous one (for rollback).
remote "docker images --format '{{.Repository}}:{{.Tag}}' | grep '^$REGISTRY/' | xargs -r docker rmi -f"
remote "sudo rm -rf /opt/lume"
remote "docker logout ghcr.io"
# Last: after this, LUME can no longer sign in to the server.
remote "rm -f ~/.ssh/authorized_keys"

if $DRY; then
  echo "[dry-run] mark $slug decommissioned in clients.yml and delete $inputs"
  exit 0
fi
inv set "$slug" status decommissioned
rm -f "$inputs"

cat <<EOF

$slug is decommissioned: no LUME containers, images, volumes, files or backups remain on $HOST, and LUME's
key is gone from its deploy user. Still to do, by hand:
  1. Revoke the registry token for ${registry_user:-this client} (GitHub → Settings → Developer settings → tokens).
  2. Remove the DNS record $slug.$DOMAIN (A $HOST).
  3. Remove the lume-deploy user (as another sudo user: sudo deluser --remove-home lume-deploy), or hand
     the server back to the client as it is.
  4. On license.lumecrm.in, Decommission the client (its record stays, marked).
EOF
