#!/usr/bin/env bash
# LUME dev loop. Edit on this PC; everything runs in containers on the build host.
# The build host is someone else's live server: see docs/superpowers/specs/2026-09-21-phase-0-foundations-design.md §2.
set -euo pipefail

HOST="${LUME_DEV_HOST:-lumedev}"
REMOTE_ROOT=/root/lume-dev
REMOTE_SRC="$REMOTE_ROOT/src"
PROJECT=lumedev
TOOLBOX=lumedev-toolbox:latest
TEST_NET=lumedev_test

cd "$(cd "$(dirname "$0")/.." && pwd)"

remote() { ssh -o BatchMode=yes "$HOST" "$@"; }

# A commit object holding the working tree (tracked + untracked, honouring .gitignore)
# without touching the real index or HEAD.
snapshot_commit() {
  local idx tree
  idx="$(mktemp)"
  # Start from the real index so file modes set with `git update-index --chmod=+x` survive
  # (Windows checkouts have core.fileMode=false, so `git add` alone would drop the executable bit).
  cp "$(git rev-parse --git-path index)" "$idx"
  GIT_INDEX_FILE="$idx" git add -A
  tree="$(GIT_INDEX_FILE="$idx" git write-tree)"
  rm -f "$idx"
  git commit-tree "$tree" -p HEAD -m "dev snapshot"
}

cmd_init() {
  remote "set -e
    mkdir -p $REMOTE_ROOT/secrets && chmod 700 $REMOTE_ROOT $REMOTE_ROOT/secrets
    [ -d $REMOTE_ROOT/repo.git ] || git init -q --bare $REMOTE_ROOT/repo.git
    [ -d $REMOTE_SRC/.git ] || git clone -q $REMOTE_ROOT/repo.git $REMOTE_SRC
    touch $REMOTE_ROOT/test.env && chmod 600 $REMOTE_ROOT/test.env
    docker network inspect $TEST_NET >/dev/null 2>&1 || docker network create --subnet 172.31.0.0/24 $TEST_NET >/dev/null"
  git remote get-url lumedev >/dev/null 2>&1 || git remote add lumedev "$HOST:$REMOTE_ROOT/repo.git"
  echo "remote ready: $HOST:$REMOTE_SRC"
}

cmd_sync() {
  local c
  c="$(snapshot_commit)"
  git push -q -f lumedev "$c:refs/heads/dev"
  remote "cd $REMOTE_SRC && git fetch -q origin dev && git reset -q --hard FETCH_HEAD && git clean -qfd"
}

cmd_toolbox() {
  cmd_sync
  remote "cd $REMOTE_SRC && nice -n 10 docker build -q -t $TOOLBOX infra/toolbox"
}

cmd_run() {
  [ $# -gt 0 ] || { echo "usage: dev.sh run <command...>" >&2; exit 2; }
  cmd_sync
  local q
  q="$(printf '%q ' "$@")"
  remote "cd $REMOTE_SRC && nice -n 10 docker run --rm -i --init --cpus 1.5 --memory 3g \
    --network $TEST_NET --env-file $REMOTE_ROOT/test.env -e CI=1 -e npm_config_store_dir=/pnpm-store \
    -v $REMOTE_SRC:/repo -v lumedev_pnpm_store:/pnpm-store -w /repo \
    $TOOLBOX bash -lc $(printf '%q' "$q")"
}

# Dependency changes: resolve in the Node 22 toolbox (lockfile only), then copy the changed
# manifests and lockfile back here so the PC stays the source of truth.
cmd_add() {
  cmd_run pnpm add --lockfile-only "$@"
  fetch_changed '(^|/)(package\.json|pnpm-lock\.yaml)$'
}

# Copy files the last remote command changed (relative to the synced snapshot) back to the PC.
fetch_changed() {
  local changed p
  changed="$(remote "cd $REMOTE_SRC && git status --porcelain --untracked-files=all | awk '{print \$NF}' | grep -E '$1' || true")"
  for p in $changed; do
    mkdir -p "$(dirname "$p")"
    scp -q "$HOST:$REMOTE_SRC/$p" "$p"
    echo "updated $p"
  done
}

cmd_fmt() {
  cmd_run pnpm exec prettier --write --log-level warn .
  fetch_changed '.'
}

compose() {
  local q
  q="$(printf '%q ' "$@")"
  remote "cd $REMOTE_SRC && docker compose -p $PROJECT --env-file $REMOTE_ROOT/.env \
    -f infra/docker-compose.yml -f infra/compose.dev.yml $q"
}

cmd_up() {
  cmd_sync
  remote "cd $REMOTE_SRC && LUME_DEV_ROOT=$REMOTE_ROOT bash infra/scripts/gen-dev-env.sh"
  remote "cd $REMOTE_SRC && nice -n 10 docker compose -p $PROJECT --env-file $REMOTE_ROOT/.env \
    -f infra/docker-compose.yml -f infra/compose.dev.yml build"
  compose up -d db
  compose run --rm migrate
  compose up -d
}

case "${1:-}" in
  init) cmd_init ;;
  sync) cmd_sync ;;
  toolbox) cmd_toolbox ;;
  run) shift; cmd_run "$@" ;;
  add) shift; cmd_add "$@" ;;
  fmt) cmd_fmt ;;
  test-db) shift; cmd_sync; remote "cd $REMOTE_SRC && LUME_DEV_ROOT=$REMOTE_ROOT bash scripts/test-db.sh ${1:-up}" ;;
  up) cmd_up ;;
  down) compose down ;;
  ps) compose ps ;;
  logs) shift; compose logs --tail=200 "$@" ;;
  compose) shift; compose "$@" ;;
  remote) shift; remote "cd $REMOTE_SRC && $*" ;;
  fetch) shift; for p in "$@"; do scp -q "$HOST:$REMOTE_SRC/$p" "$p"; done ;;
  tunnel)
    echo "https://lume.localhost:8443 and Mailpit http://127.0.0.1:8025 → $HOST (Ctrl+C to stop)"
    ssh -N -L 8443:127.0.0.1:8443 -L 8025:127.0.0.1:8025 "$HOST" ;;
  *) echo "usage: dev.sh {init|sync|toolbox|run|add|fmt|test-db|up|down|ps|logs|compose|remote|fetch|tunnel}" >&2; exit 2 ;;
esac
