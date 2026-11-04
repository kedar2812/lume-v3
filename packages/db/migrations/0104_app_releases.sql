-- What's new (final review 2026-11-05): when this installation first ran each version. Every client updates on its own
-- day, so the week of "New" and "joined after the update" count from here (or the release's own day, if later).
CREATE TABLE app_releases (
  version      text        PRIMARY KEY CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  first_run_at timestamptz NOT NULL DEFAULT now()
);
REVOKE UPDATE, DELETE ON app_releases FROM lume_app, lume_worker;
