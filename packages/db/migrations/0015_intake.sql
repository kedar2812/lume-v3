-- Phase 2A intake (spec 2026-09-27 §4). Sources say where leads came from; an import is one run over a
-- file; every row of it gets one write-once result. Configuration-like: no RLS (the API enforces the
-- permissions); lume_worker may only clear old files and raw rows (retention), never read lead data.
CREATE TABLE lead_sources (
  id uuid PRIMARY KEY,
  type text NOT NULL CONSTRAINT lead_sources_type CHECK (type IN ('csv', 'google_sheet', 'webhook', 'manual')),
  name text NOT NULL,
  config_enc bytea,
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CONSTRAINT lead_sources_status CHECK (status IN ('active', 'paused', 'needs_attention', 'archived')),
  last_synced_at timestamptz,
  last_error text,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE imports (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES lead_sources (id) ON DELETE CASCADE,
  kind text NOT NULL CONSTRAINT imports_kind CHECK (kind IN ('csv')),
  status text NOT NULL CONSTRAINT imports_status CHECK (status IN ('draft', 'queued', 'running', 'cancelling', 'cancelled', 'stopped_access', 'failed', 'done')),
  file_enc bytea,
  file_sha256 text NOT NULL,
  file_name text NOT NULL,
  file_bytes integer NOT NULL,
  encoding text,
  delimiter text,
  header_row integer,
  headers jsonb NOT NULL DEFAULT '[]'::jsonb,
  row_count integer NOT NULL DEFAULT 0,
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  column_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  cursor_row integer NOT NULL DEFAULT 0,
  rr_cursor integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  created integer NOT NULL DEFAULT 0,
  merged integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  empty integer NOT NULL DEFAULT 0,
  errors integer NOT NULL DEFAULT 0,
  warnings integer NOT NULL DEFAULT 0,
  name_from_contact integer NOT NULL DEFAULT 0,
  missing_stage_fields integer NOT NULL DEFAULT 0,
  phone_needs_country integer NOT NULL DEFAULT 0,
  started_by uuid REFERENCES users (id),
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  seen_at timestamptz,
  stop_reason text,
  purged_at timestamptz
);
CREATE INDEX imports_recent ON imports (created_at DESC);
CREATE INDEX imports_sha ON imports (file_sha256) WHERE status = 'done';

CREATE TABLE import_rows (
  id bigserial PRIMARY KEY,
  import_id uuid NOT NULL REFERENCES imports (id) ON DELETE CASCADE,
  row_index integer NOT NULL,
  fingerprint text,
  raw_enc bytea,
  result text NOT NULL CONSTRAINT import_rows_result CHECK (result IN ('pending', 'created', 'merged', 'skipped', 'error')),
  lead_id uuid,
  problems jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  also_matched uuid[] NOT NULL DEFAULT '{}',
  CONSTRAINT import_rows_once UNIQUE (import_id, row_index)
);
CREATE INDEX import_rows_by_result ON import_rows (import_id, result, row_index);

CREATE TABLE import_mapping_memory (
  header_signature text PRIMARY KEY,
  mapping jsonb NOT NULL,
  rules jsonb NOT NULL,
  updated_by uuid REFERENCES users (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Default privileges gave lume_worker everything on new tables; take it back to retention only.
REVOKE ALL ON lead_sources, imports, import_rows, import_mapping_memory FROM lume_worker;
GRANT SELECT (id, source_id, status, finished_at, created_at, purged_at), UPDATE (file_enc, purged_at) ON imports TO lume_worker;
GRANT DELETE ON imports TO lume_worker;
GRANT SELECT (import_id), UPDATE (raw_enc) ON import_rows TO lume_worker;
GRANT SELECT (id), DELETE ON lead_sources TO lume_worker;
