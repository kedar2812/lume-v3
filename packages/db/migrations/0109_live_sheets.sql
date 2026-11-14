-- Live sheets (owner 2026-11-14, docs/superpowers/specs/2026-11-14-live-sheets-design.md): Google Sheets LUME makes in
-- a client's own Drive and keeps filled with the leads a rule picks. LUME may open only the files it makes (drive.file).

-- LUME's runs read a sheet's Google account as whoever the sheet runs as, who may not be the person who connected it
-- (an admin who took a sheet over): the sweep flag lets that run, and only it, read the grant.
CREATE FUNCTION lume_live_sheets_sweep() RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(current_setting('lume.live_sheets_sweep', true) = 'on', false)
$$;

-- Connecting Google for live sheets goes through the relay with its own kind.
ALTER TABLE oauth_connects DROP CONSTRAINT oauth_connects_kind;
ALTER TABLE oauth_connects ADD CONSTRAINT oauth_connects_kind
  CHECK (kind IN ('sheet', 'calendar', 'whatsapp', 'live_sheet'));

-- A person's Google account for live sheets, through the relay (kind live_sheet). Their own row only.
CREATE TABLE live_sheet_grants (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  google_email text NOT NULL CONSTRAINT live_sheet_grants_email CHECK (char_length(google_email) BETWEEN 3 AND 320),
  -- The sealed refresh token, bound to this row (live-sheet-grant:<id>), as a calendar's grant is.
  grant_enc bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT live_sheet_grants_one UNIQUE (user_id, google_email)
);
ALTER TABLE live_sheet_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_sheet_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY live_sheet_grants_read ON live_sheet_grants FOR SELECT
  USING (user_id = lume_user() OR lume_live_sheets_sweep());
CREATE POLICY live_sheet_grants_create ON live_sheet_grants FOR INSERT WITH CHECK (user_id = lume_user());
CREATE POLICY live_sheet_grants_update ON live_sheet_grants FOR UPDATE
  USING (user_id = lume_user()) WITH CHECK (user_id = lume_user());
-- Deleting someone's account forgets their Google accounts too (with the sweep flag, whoever deletes it).
CREATE POLICY live_sheet_grants_delete ON live_sheet_grants FOR DELETE
  USING (user_id = lume_user() OR lume_live_sheets_sweep());
CREATE POLICY backup_read ON live_sheet_grants FOR SELECT TO lume_readonly_backup USING (true);

-- A live sheet: its rule and columns, the Google file, who it runs as, and where it stands.
CREATE TABLE live_sheets (
  id uuid PRIMARY KEY,
  name text NOT NULL CONSTRAINT live_sheets_name CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  preset text NOT NULL CONSTRAINT live_sheets_preset CHECK (preset IN ('meta', 'own')),
  rule jsonb NOT NULL,
  -- Column ids as lead exports name them: name, email, phone, custom:<key>, …
  columns jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The header LUME last wrote: a change rewrites it and starts the hand-edit record afresh.
  header jsonb NOT NULL DEFAULT '[]'::jsonb,
  edits text NOT NULL CONSTRAINT live_sheets_edits CHECK (edits IN ('keep', 'replace')),
  -- Empty once its Google account is forgotten (its person's account deleted): the sheet pauses, disconnected.
  grant_id uuid REFERENCES live_sheet_grants (id) ON DELETE SET NULL,
  spreadsheet_id text,
  -- The name LUME last gave the file and its first tab: a rename in LUME renames them at the next run.
  written_name text,
  url text CONSTRAINT live_sheets_url CHECK (url IS NULL OR url ~ '^https://docs\.google\.com/'),
  tab_id integer,
  made_by uuid NOT NULL REFERENCES users (id),
  runs_as uuid NOT NULL REFERENCES users (id),
  status text NOT NULL DEFAULT 'making'
    CONSTRAINT live_sheets_status CHECK (status IN ('making', 'live', 'updating', 'paused')),
  pause_reason text CONSTRAINT live_sheets_pause_reason CHECK (pause_reason IS NULL OR pause_reason IN
    ('google_disconnected', 'sheet_gone', 'maker_gone', 'tier', 'licence', 'paused_by_person')),
  -- The last error Google gave a run that will be tried again ("Google is slow"); cleared by the next good run.
  last_error text,
  lead_count integer NOT NULL DEFAULT 0,
  -- More leads match than one sheet holds: it keeps the newest.
  capped boolean NOT NULL DEFAULT false,
  -- Drive's modifiedTime after LUME's last write: unchanged means nobody edited the sheet since.
  google_modified_at text,
  last_synced_at timestamptz,
  next_sync_at timestamptz NOT NULL DEFAULT now(),
  failures integer NOT NULL DEFAULT 0,
  poll_seconds integer NOT NULL DEFAULT 120 CONSTRAINT live_sheets_poll CHECK (poll_seconds BETWEEN 60 AND 3600),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX live_sheets_due ON live_sheets (next_sync_at) WHERE deleted_at IS NULL;

-- What LUME last wrote for each lead's row, so an update writes only what changed and can tell a hand edit. No foreign
-- key to the lead: a lead purged from the bin keeps its row here until LUME has taken it out of the sheet.
CREATE TABLE live_sheet_rows (
  sheet_id uuid NOT NULL REFERENCES live_sheets (id) ON DELETE CASCADE,
  lead_id uuid NOT NULL,
  hash text NOT NULL,
  cells jsonb NOT NULL,
  edited_cols integer[] NOT NULL DEFAULT '{}',
  removed_by_hand boolean NOT NULL DEFAULT false,
  written_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sheet_id, lead_id)
);

-- Each run of a sheet: what started it and how far it got, for the progress bar. One queued or running at a time.
CREATE TABLE live_sheet_runs (
  id uuid PRIMARY KEY,
  sheet_id uuid NOT NULL REFERENCES live_sheets (id) ON DELETE CASCADE,
  trigger text NOT NULL CONSTRAINT live_sheet_runs_trigger CHECK (trigger IN ('make', 'schedule', 'refresh', 'now', 'edit')),
  requested_by uuid REFERENCES users (id) ON DELETE SET NULL,
  status text NOT NULL CONSTRAINT live_sheet_runs_status CHECK (status IN ('queued', 'running', 'done', 'failed')),
  total integer NOT NULL DEFAULT 0,
  written integer NOT NULL DEFAULT 0,
  error text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE UNIQUE INDEX live_sheet_runs_one ON live_sheet_runs (sheet_id) WHERE status IN ('queued', 'running');
CREATE INDEX live_sheet_runs_recent ON live_sheet_runs (sheet_id, requested_at DESC);

-- Refresh (owner 2026-11-14) updates live sheets too: the runs one press started or joined, for its card.
ALTER TABLE source_refreshes ADD COLUMN live_run_ids uuid[] NOT NULL DEFAULT '{}';

-- The worker never reads live sheets: the API runs them (lead data and Google grants stay with lume_app).
REVOKE ALL ON live_sheet_grants, live_sheets, live_sheet_rows, live_sheet_runs FROM lume_worker;

-- Make live sheets: every role that may export leads (a live sheet takes them out of LUME); new installs through the
-- Admin preset. The boot sync keeps the permission's words.
INSERT INTO permissions (key, "group", label, description, supports_scope, retired)
VALUES ('leads.live_sheets', 'Leads', 'Make live sheets', 'Google Sheets LUME keeps up to date', false, false)
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key, scope)
SELECT DISTINCT role_id, 'leads.live_sheets', NULL::text FROM role_permissions WHERE permission_key = 'leads.export'
ON CONFLICT DO NOTHING;
