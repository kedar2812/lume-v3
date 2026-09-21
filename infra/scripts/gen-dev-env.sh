#!/usr/bin/env bash
# Build host only: create $LUME_DEV_ROOT/.env and the restore-test age key once. Idempotent.
# The "offline" dev key's private half is written to secrets/offline.agekey for the owner to fetch and delete.
set -euo pipefail
ROOT="${LUME_DEV_ROOT:?}"
SECRETS="$ROOT/secrets"
mkdir -p "$SECRETS" && chmod 700 "$SECRETS"
[ -f "$ROOT/.env" ] && { echo ".env exists, leaving it untouched"; exit 0; }

gen() { openssl rand -hex 24; }
keygen() { docker run --rm lumedev-toolbox:latest age-keygen 2>/dev/null; }

restore_key="$(keygen)"
offline_key="$(keygen)"
printf '%s\n' "$restore_key" > "$SECRETS/restore.agekey"
printf '%s\n' "$offline_key" > "$SECRETS/offline.agekey"
chown 1000:1000 "$SECRETS/restore.agekey" && chmod 400 "$SECRETS/restore.agekey"
chmod 400 "$SECRETS/offline.agekey"
pub() { grep -o 'age1[0-9a-z]*' <<<"$1" | head -n 1; }

umask 077
cat > "$ROOT/.env" <<EOF
LUME_PUBLIC_HOST=lume.localhost
LUME_TLS=tls internal
LUME_MASTER_KEY=$(openssl rand -base64 32)
POSTGRES_SUPERUSER_PASSWORD=$(gen)
LUME_OWNER_PASSWORD=$(gen)
LUME_APP_PASSWORD=$(gen)
LUME_WORKER_PASSWORD=$(gen)
LUME_BACKUP_PASSWORD=$(gen)
LUME_RESTORE_PASSWORD=$(gen)
BACKUP_AGE_RECIPIENTS=$(pub "$offline_key"),$(pub "$restore_key")
LUME_SECRETS_DIR=$SECRETS
RCLONE_CONFIG_OFFSITE_TYPE=local
RCLONE_REMOTE=offsite:/var/lib/lume/offsite
LOG_LEVEL=info
LUME_IMAGE_PREFIX=lume
LUME_TAG=dev
EOF
echo "generated $ROOT/.env and age keys (fetch secrets/offline.agekey to the owner's PC, then delete it)"
