-- Phase 6B (plan 2026-10-02-phase-6b-exports): lead exports you can trace. Each export's file is sealed with the
-- instance keyring and kept here for 24 hours (plan ruling B2); its code and its made-up check row stay, so a
-- file found later still traces back to it.

CREATE TABLE lead_exports (
  id                 uuid        PRIMARY KEY,
  user_id            uuid        NOT NULL REFERENCES users (id),
  code               char(9)     NOT NULL UNIQUE CHECK (code ~ '^[A-Z2-9]{4}-[A-Z2-9]{4}$'),
  label              text        NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  format             text        NOT NULL CHECK (format IN ('csv', 'xlsx')),
  filters            jsonb       NOT NULL DEFAULT '{}',
  columns            text[]      NOT NULL,
  row_count          integer     NOT NULL CHECK (row_count > 0),
  -- The check row: random per export, stored (plan ruling B3).
  check_name         text        NOT NULL,
  check_email        text        NOT NULL UNIQUE,
  check_phone        text        NOT NULL,
  check_position     integer     NOT NULL CHECK (check_position >= 0),
  file_enc           bytea,
  downloads          integer     NOT NULL DEFAULT 0,
  last_downloaded_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  cleared_at         timestamptz
);
CREATE INDEX lead_exports_created ON lead_exports (created_at DESC);
CREATE INDEX lead_exports_check_phone ON lead_exports (check_phone);
GRANT SELECT, INSERT, UPDATE ON lead_exports TO lume_app;
