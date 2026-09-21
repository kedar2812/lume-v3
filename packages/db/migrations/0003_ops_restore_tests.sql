-- One row per automated restore test (report §12.7), shown on System health in Phase 3. Append-only.
CREATE TABLE ops_restore_tests (
  id          bigserial PRIMARY KEY,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  backup_name text        NOT NULL,
  ok          boolean     NOT NULL,
  details     jsonb       NOT NULL DEFAULT '{}'::jsonb
);
REVOKE INSERT, UPDATE, DELETE ON ops_restore_tests FROM lume_app;
REVOKE UPDATE, DELETE ON ops_restore_tests FROM lume_worker;
