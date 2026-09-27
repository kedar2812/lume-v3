-- Phase 2B-1 (spec 2026-09-27-phase-2b §4, amendments A1–A8). A Google Sheet is a lead source that is read again
-- and again: it remembers where it read to, which rows it has dealt with, and every sync it ran.
ALTER TABLE settings ADD COLUMN integrations jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN leads_seen_at timestamptz;

ALTER TABLE lead_sources DROP CONSTRAINT lead_sources_status;
ALTER TABLE lead_sources ADD CONSTRAINT lead_sources_status
  CHECK (status IN ('draft', 'active', 'paused', 'needs_attention', 'archived'));
ALTER TABLE lead_sources
  ADD COLUMN headers jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN column_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN run_as uuid REFERENCES users (id),
  ADD COLUMN poll_seconds integer NOT NULL DEFAULT 120 CONSTRAINT lead_sources_poll CHECK (poll_seconds BETWEEN 60 AND 3600),
  ADD COLUMN next_sync_at timestamptz,
  ADD COLUMN last_modified text,
  ADD COLUMN rows_read integer NOT NULL DEFAULT 0,
  ADD COLUMN head_hash text,
  ADD COLUMN full_read_at timestamptz,
  ADD COLUMN current_sync_id uuid,
  ADD COLUMN sync_lock_until timestamptz,
  ADD COLUMN rr_cursor integer NOT NULL DEFAULT 0,
  ADD COLUMN failures integer NOT NULL DEFAULT 0,
  ADD COLUMN attention_code text,
  ADD COLUMN new_columns jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN config_version integer NOT NULL DEFAULT 1,
  ADD COLUMN synced_config_version integer,
  ADD COLUMN baseline boolean NOT NULL DEFAULT false;
CREATE INDEX lead_sources_due ON lead_sources (next_sync_at) WHERE type = 'google_sheet' AND status = 'active';

ALTER TABLE imports DROP CONSTRAINT imports_kind;
ALTER TABLE imports ADD CONSTRAINT imports_kind CHECK (kind IN ('csv', 'sheet'));
-- An edit of a live sheet's columns is a draft on a throwaway source; this names the live one (A1).
ALTER TABLE imports ADD COLUMN target_source_id uuid REFERENCES lead_sources (id) ON DELETE CASCADE;

CREATE TABLE source_rows (
  id bigserial PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES lead_sources (id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  result text NOT NULL CONSTRAINT source_rows_result
    CHECK (result IN ('pending', 'created', 'merged', 'skipped', 'error', 'dismissed', 'superseded')),
  lead_id uuid,
  sync_id uuid,
  row_number integer NOT NULL,
  problems jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_enc bytea,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_tried_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_rows_once UNIQUE (source_id, fingerprint)
);
CREATE INDEX source_rows_problems ON source_rows (source_id, row_number) WHERE result = 'error';
CREATE INDEX source_rows_by_sync ON source_rows (sync_id);
CREATE INDEX source_rows_created ON source_rows (source_id, first_seen_at) WHERE result = 'created';

CREATE TABLE source_syncs (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES lead_sources (id) ON DELETE CASCADE,
  trigger text NOT NULL CONSTRAINT source_syncs_trigger CHECK (trigger IN ('schedule', 'refresh', 'connect', 'manual')),
  requested_by uuid REFERENCES users (id),
  status text NOT NULL CONSTRAINT source_syncs_status CHECK (status IN ('queued', 'running', 'done', 'failed')),
  rows_total integer NOT NULL DEFAULT 0,
  rows_read integer NOT NULL DEFAULT 0,
  created integer NOT NULL DEFAULT 0,
  merged integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  errors integer NOT NULL DEFAULT 0,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  error text
);
CREATE INDEX source_syncs_recent ON source_syncs (source_id, requested_at DESC);

CREATE TABLE source_refreshes (
  id uuid PRIMARY KEY,
  requested_by uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  sync_ids uuid[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX source_refreshes_by_user ON source_refreshes (requested_by, created_at DESC);

-- Configuration-like, as in 0015: no RLS; the API enforces permissions. The worker only sweeps old history.
REVOKE ALL ON source_rows, source_syncs, source_refreshes FROM lume_worker;
REVOKE ALL ON SEQUENCE source_rows_id_seq FROM lume_worker;
GRANT SELECT (id, requested_at), DELETE ON source_syncs TO lume_worker;
GRANT SELECT (id, created_at), DELETE ON source_refreshes TO lume_worker;
