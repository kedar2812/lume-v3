-- Licensing L-A (spec 2026-09-30 §3): what this instance knows of its licence — the last good token from the
-- licence server, when it first booted and when it last heard back — and, per session, the payment reminder
-- the person closed ("I'll sort it" closes it for that session only).
CREATE TABLE licence_state (
  id              smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  token           text,
  first_boot_at   timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error      text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO licence_state (id) VALUES (1);
-- One row, only ever updated by the API.
REVOKE INSERT, DELETE, TRUNCATE ON licence_state FROM lume_app;
REVOKE ALL ON licence_state FROM lume_worker;

ALTER TABLE sessions ADD COLUMN notice_dismissed text;
