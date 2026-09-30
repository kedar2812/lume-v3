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

# accept-new: a new server's first host key is taken (and pinned in known_hosts), so the very first
# connection needs no manual step; a changed key is still refused. LUME_SSH_KEY: use that key only (an ssh
# agent holding many keys would use up the server's MaxAuthTries).
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
if [ -n "${LUME_SSH_KEY:-}" ]; then SSH_OPTS+=(-i "$LUME_SSH_KEY" -o IdentitiesOnly=yes); fi
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

# Run one step on the client's server. Its exit code is the script's if it fails (set -e). -n: nothing on
# this machine's stdin reaches it (remote_stdin is the one step that sends something on stdin).
remote() {
  if $DRY; then
    printf '[dry-run] ssh %s@%s %s\n' "$DEPLOY_USER" "$HOST" "$*"
    return 0
  fi
  # shellcheck disable=SC2029 # the step is meant to be expanded here, then run there
  ssh -n "${SSH_OPTS[@]}" "$DEPLOY_USER@$HOST" "$@"
}
remote_stdin() {
  if $DRY; then
    printf '[dry-run] ssh %s@%s %s (with its input)\n' "$DEPLOY_USER" "$HOST" "$*"
    return 0
  fi
  # shellcheck disable=SC2029 # as above
  ssh "${SSH_OPTS[@]}" "$DEPLOY_USER@$HOST" "$@"
}

# Copy a local file to the client's server.
upload() {
  if $DRY; then
    printf '[dry-run] scp %s %s@%s:%s\n' "$1" "$DEPLOY_USER" "$HOST" "$2"
    return 0
  fi
  scp -q "${SSH_OPTS[@]}" "$1" "$DEPLOY_USER@$HOST:$2"
}
