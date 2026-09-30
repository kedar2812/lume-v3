#!/usr/bin/env bash
# Shared by the fleet scripts (licensing L-C): the inventory, one client's host, and running a step there.
# Every remote step goes over ssh as the client's deploy user; --dry-run prints each step and calls nothing.
# Sourced, never run.

FLEET_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The build host runs another client's live site and LUME's own development: never a fleet target.
BUILD_HOST="200.97.166.16"
DRY=false
HOST=""
DEPLOY_USER=""
SLUG=""

inv() { node "$FLEET_ROOT/scripts/fleet/inventory.mjs" "$@"; }
step() { printf '\n== %s\n' "$*"; }
die() {
  printf '%s\n' "$*" >&2
  exit 1
}

# Pick up --dry-run anywhere among the arguments; the rest are left in ARGS.
ARGS=()
parse_dry() {
  for a in "$@"; do
    if [ "$a" = "--dry-run" ]; then DRY=true; else ARGS+=("$a"); fi
  done
}

# Choose a client from the inventory: sets SLUG, HOST and DEPLOY_USER.
target() {
  SLUG="$1"
  HOST="$(inv get "$SLUG" host)" || exit 2
  DEPLOY_USER="$(inv get "$SLUG" user)" || exit 2
  DEPLOY_USER="${DEPLOY_USER:-lume-deploy}"
  if [ "$HOST" = "$BUILD_HOST" ]; then
    die "refusing $SLUG: $HOST is the build host (another client's live server), never a LUME client"
  fi
}

# Run one step on the client's server. Its exit code is the script's if it fails (set -e).
remote() {
  if $DRY; then
    printf '[dry-run] ssh %s@%s %s\n' "$DEPLOY_USER" "$HOST" "$*"
    return 0
  fi
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$DEPLOY_USER@$HOST" "$@"
}

# Copy a local file to the client's server.
upload() {
  if $DRY; then
    printf '[dry-run] scp %s %s@%s:%s\n' "$1" "$DEPLOY_USER" "$HOST" "$2"
    return 0
  fi
  scp -q -o BatchMode=yes "$1" "$DEPLOY_USER@$HOST:$2"
}
