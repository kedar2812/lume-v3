-- Instagram flows (2026-11-22; NEW_FEATURES_PLAN §4.5, plan 1B Task 2): what a business builds to answer a keyword
-- comment, a keyword DM, a story reply or mention, an ad click or a first message, as a vertical list of steps; each
-- publish an unchangeable version; each conversation in a flow a run; and what each flow and keyword brought.

-- A flow. Configuration, no lead data: no row-level security; reached by routes that check instagram.flows.manage.
CREATE TABLE instagram_flows (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  status text NOT NULL CHECK (status IN ('draft', 'live', 'paused', 'archived')),
  live_version_id uuid,
  priority integer NOT NULL DEFAULT 0,
  -- What the editor holds between publishes (may not be publishable yet), and a counter so two people editing at
  -- once can't overwrite each other unseen.
  draft_steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  rev integer NOT NULL DEFAULT 1,
  -- Round robin's turn for an assign step: one counter, never a count of the flow's runs.
  rr bigint NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'live' OR live_version_id IS NOT NULL)
);

-- A published version: its steps never change once written (running conversations finish on theirs).
CREATE TABLE instagram_flow_versions (
  id uuid PRIMARY KEY,
  flow_id uuid NOT NULL REFERENCES instagram_flows (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  steps jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flow_id, version)
);
ALTER TABLE instagram_flows
  ADD CONSTRAINT instagram_flows_live_version FOREIGN KEY (live_version_id) REFERENCES instagram_flow_versions (id);
CREATE FUNCTION lume_flow_version_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a published flow version never changes' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER instagram_flow_versions_frozen BEFORE UPDATE ON instagram_flow_versions
  FOR EACH ROW EXECUTE FUNCTION lume_flow_version_frozen();

-- What starts a flow. A keyword list is matched as whole words; `media_ids` and `ad_ids` narrow it (empty: all).
CREATE TABLE instagram_triggers (
  id uuid PRIMARY KEY,
  flow_id uuid NOT NULL REFERENCES instagram_flows (id) ON DELETE CASCADE,
  account_id uuid REFERENCES instagram_accounts (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('comment', 'dm', 'story_reply', 'story_mention', 'ad', 'welcome')),
  keywords text[] NOT NULL DEFAULT '{}' CHECK (cardinality(keywords) <= 50),
  mode text NOT NULL DEFAULT 'word' CHECK (mode IN ('word', 'exact', 'any')),
  media_ids text[] NOT NULL DEFAULT '{}',
  ad_ids text[] NOT NULL DEFAULT '{}',
  public_replies text[] NOT NULL DEFAULT '{}' CHECK (cardinality(public_replies) <= 10),
  cooldown_hours integer NOT NULL DEFAULT 24 CHECK (cooldown_hours BETWEEN 0 AND 720),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX instagram_triggers_kind ON instagram_triggers (kind) WHERE enabled;

-- A conversation in a flow. One running (or waiting) run per conversation at a time.
CREATE TABLE instagram_flow_runs (
  id uuid PRIMARY KEY,
  flow_id uuid NOT NULL REFERENCES instagram_flows (id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES instagram_flow_versions (id) ON DELETE CASCADE,
  trigger_id uuid REFERENCES instagram_triggers (id) ON DELETE SET NULL,
  thread_id uuid NOT NULL REFERENCES instagram_threads (id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('running', 'waiting', 'done', 'stopped', 'handed', 'failed')),
  state jsonb NOT NULL,
  started_by text NOT NULL,
  keyword text,
  next_at timestamptz,
  reason text,
  -- Failed attempts at a due step (the fifth ends the run as failed, with words).
  tries integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX instagram_flow_runs_one ON instagram_flow_runs (thread_id) WHERE status IN ('running', 'waiting');
CREATE INDEX instagram_flow_runs_due ON instagram_flow_runs (next_at) WHERE status = 'waiting' AND next_at IS NOT NULL;
CREATE INDEX instagram_flow_runs_recent ON instagram_flow_runs (thread_id, created_at DESC);
-- Archive, the flows list's counts and a flow's numbers read one flow's runs.
CREATE INDEX instagram_flow_runs_flow ON instagram_flow_runs (flow_id, status);

-- What each flow and keyword brought, as it happens (the analytics source; no words).
CREATE TABLE instagram_flow_events (
  id bigserial PRIMARY KEY,
  flow_id uuid NOT NULL REFERENCES instagram_flows (id) ON DELETE CASCADE,
  version_id uuid,
  trigger_id uuid,
  run_id uuid,
  -- The step that wrote it: a step's job run twice writes once (UNIQUE below). Null for events outside a step.
  step_key text,
  keyword text,
  kind text NOT NULL CHECK (kind IN ('triggered', 'private_reply', 'dm_sent', 'replied', 'lead_created', 'call_booked', 'handed')),
  lead_id uuid REFERENCES leads (id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX instagram_flow_events_flow ON instagram_flow_events (flow_id, at);
CREATE UNIQUE INDEX instagram_flow_events_once ON instagram_flow_events (run_id, kind, step_key)
  WHERE run_id IS NOT NULL AND step_key IS NOT NULL;

ALTER TABLE instagram_flow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_flow_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY instagram_flow_runs_seen ON instagram_flow_runs
  USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id))
  WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));
CREATE POLICY backup_read ON instagram_flow_runs FOR SELECT TO lume_readonly_backup USING (true);

-- The automated-experience note Meta asks for where the law requires it: sent once at a run's start (on by default),
-- and the words that ask for a person at any point of a run. Each business can change both; the note should name one.
ALTER TABLE instagram_accounts
  ADD COLUMN automated_note text DEFAULT 'You''re chatting with an automated assistant. Reply PERSON to reach the team.'
    CHECK (automated_note IS NULL OR octet_length(automated_note) <= 1000),
  ADD COLUMN person_words text[] NOT NULL DEFAULT '{PERSON}'
    CHECK (cardinality(person_words) <= 10);

-- Who may build flows: whoever manages integrations, on existing installs; Admin through its preset on new ones.
INSERT INTO permissions (key, "group", label, description, supports_scope, retired)
VALUES ('instagram.flows.manage', 'Admin', 'Manage Instagram flows', 'Build and publish Instagram automations', false, false)
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key, scope)
SELECT role_id, 'instagram.flows.manage', NULL FROM role_permissions WHERE permission_key = 'integrations.manage'
ON CONFLICT DO NOTHING;

REVOKE ALL ON instagram_flows, instagram_flow_versions, instagram_triggers, instagram_flow_runs, instagram_flow_events
  FROM lume_worker;
REVOKE ALL ON SEQUENCE instagram_flow_events_id_seq FROM lume_worker;

-- A public reply under a comment (0118's public_reply_at, stamped when a flow queues it): so many an hour per account.
CREATE INDEX instagram_comments_public ON instagram_comments (account_id, public_reply_at)
  WHERE public_reply_at IS NOT NULL;

-- Meta's data deletion forgets what people answered in flows too (their typed emails, phones and words).
CREATE OR REPLACE FUNCTION lume_instagram_forget(acct uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('lume.lead_scope', 'all', true);
  UPDATE activities a
     SET payload = (a.payload - 'text' - 'attachments' - 'story' - 'tap' - 'referral') || '{"forgotten": true}'::jsonb
   WHERE a.type IN ('instagram_received', 'instagram_sent')
     AND (a.payload->>'accountId' = acct::text
          OR a.payload->>'threadId' IN (SELECT t.id::text FROM instagram_threads t WHERE t.account_id = acct));
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE instagram_flow_runs r SET state = jsonb_set(r.state, '{answers}', '{}'::jsonb)
   WHERE r.thread_id IN (SELECT t.id FROM instagram_threads t WHERE t.account_id = acct) AND r.state ? 'answers';
  DELETE FROM instagram_inbox WHERE thread_id IN (SELECT id FROM instagram_threads WHERE account_id = acct);
  DELETE FROM instagram_media WHERE account_id = acct;
  DELETE FROM instagram_comments WHERE account_id = acct;
  DELETE FROM instagram_events WHERE account_ig_id = (SELECT ig_user_id FROM instagram_accounts WHERE id = acct);
  UPDATE instagram_threads SET username = NULL, name = NULL, source = '{}'::jsonb WHERE account_id = acct;
  PERFORM set_config('lume.lead_scope', '', true);
  RETURN n;
END $$;
