#!/usr/bin/env bash
# Disposable Postgres 17 for integration tests. On lumedev it publishes NO port and is reachable only
# from the lumedev_test network. CI sets TEST_DB_PUBLISH to reach it on 127.0.0.1.
set -euo pipefail
NAME=lumedev-pgtest
NET=lumedev_test
ROOT="${LUME_DEV_ROOT:-/root/lume-dev}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"

up() {
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create --subnet 172.31.0.0/24 "$NET" >/dev/null
  if [ -n "$(docker ps -q -f "name=^${NAME}$")" ]; then echo "$NAME already running"; return; fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  local su owner app worker backup restore publish=() host="$NAME:5432"
  su="$(openssl rand -hex 24)"; owner="$(openssl rand -hex 24)"; app="$(openssl rand -hex 24)"
  worker="$(openssl rand -hex 24)"; backup="$(openssl rand -hex 24)"; restore="$(openssl rand -hex 24)"
  if [ -n "${TEST_DB_PUBLISH:-}" ]; then publish=(-p "127.0.0.1:${TEST_DB_PUBLISH}:5432"); host="127.0.0.1:${TEST_DB_PUBLISH}"; fi
  docker run -d --name "$NAME" --network "$NET" "${publish[@]}" --cpus 1 --memory 1g \
    --tmpfs /var/lib/postgresql/data:rw,size=1g \
    -e POSTGRES_PASSWORD="$su" -e LUME_OWNER_PASSWORD="$owner" -e LUME_APP_PASSWORD="$app" \
    -e LUME_WORKER_PASSWORD="$worker" -e LUME_BACKUP_PASSWORD="$backup" -e LUME_RESTORE_PASSWORD="$restore" \
    -v "$SRC/infra/postgres/init:/docker-entrypoint-initdb.d:ro" \
    -v "$SRC/infra/postgres/pg_hba.test.conf:/etc/postgresql/pg_hba.conf:ro" \
    postgres:17 -c hba_file=/etc/postgresql/pg_hba.conf -c fsync=off -c shared_buffers=128MB -c max_connections=200 >/dev/null
  for _ in $(seq 1 60); do
    if docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U postgres; then break; fi
    sleep 1
  done
  docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U postgres || { docker logs "$NAME" | tail -40; exit 1; }
  umask 077
  cat > "$ROOT/test.env" <<EOF
TEST_DATABASE_URL=postgres://postgres:${su}@${host}/postgres
TEST_PW_LUME_OWNER=${owner}
TEST_PW_LUME_APP=${app}
TEST_PW_LUME_WORKER=${worker}
TEST_PW_LUME_READONLY_BACKUP=${backup}
TEST_PW_LUME_RESTORE=${restore}
EOF
  echo "$NAME ready"
}

down() { docker rm -f "$NAME" >/dev/null 2>&1 || true; : > "$ROOT/test.env"; echo "$NAME removed"; }

case "${1:-up}" in up) up ;; down) down ;; *) echo "usage: test-db.sh up|down" >&2; exit 2 ;; esac
