#!/usr/bin/env bash
# First boot only (docker-entrypoint-initdb.d), run by the image's bootstrap superuser.
# Creates LUME's roles (report §12.4) and the database. Grants live in versioned migrations.
set -euo pipefail
: "${LUME_DB_NAME:=lume}"
for v in LUME_OWNER_PASSWORD LUME_APP_PASSWORD LUME_WORKER_PASSWORD LUME_BACKUP_PASSWORD LUME_RESTORE_PASSWORD; do
  [ -n "${!v:-}" ] || { echo "00-roles.sh: $v is required" >&2; exit 1; }
done

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_pw="$LUME_OWNER_PASSWORD" -v app_pw="$LUME_APP_PASSWORD" -v worker_pw="$LUME_WORKER_PASSWORD" \
  -v backup_pw="$LUME_BACKUP_PASSWORD" -v restore_pw="$LUME_RESTORE_PASSWORD" -v dbname="$LUME_DB_NAME" <<'SQL'
SET password_encryption = 'scram-sha-256';
CREATE ROLE lume_owner           LOGIN PASSWORD :'owner_pw'   NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE ROLE lume_app             LOGIN PASSWORD :'app_pw'     NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE ROLE lume_worker          LOGIN PASSWORD :'worker_pw'  NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE ROLE lume_readonly_backup LOGIN PASSWORD :'backup_pw'  NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE ROLE lume_restore         LOGIN PASSWORD :'restore_pw' NOSUPERUSER NOCREATEROLE CREATEDB   NOBYPASSRLS;
CREATE DATABASE :"dbname" OWNER lume_owner;
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO lume_app, lume_worker, lume_readonly_backup;
SQL
