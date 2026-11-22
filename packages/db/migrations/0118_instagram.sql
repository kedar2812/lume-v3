-- Instagram, the channel (2026-11-22; docs/NEW_FEATURES_PLAN.md §4–5, plan 1A Task 3): the business's connected
-- Instagram professional accounts, Meta's deliveries as they arrive, each conversation (a lead's, or one waiting in "Not
-- a lead yet"), comments with their one private reply, messages sent from LUME, and the photos people send.

-- Each connected account: whose it is (a person, or the business when null), who connected it (its jobs run as them),
-- the lead source its new leads come in under, and its 60-day token, encrypted with the keyring. Configuration, no lead
-- data: no row-level security; the token column is never selected by a route.
CREATE TABLE instagram_accounts (
  id uuid PRIMARY KEY,
  ig_user_id text NOT NULL UNIQUE CHECK (ig_user_id ~ '^[0-9]{5,30}$'),
  username text NOT NULL,
  name text,
  account_type text,
  owner_user_id uuid REFERENCES users (id),
  run_as uuid NOT NULL REFERENCES users (id),
  source_id uuid REFERENCES lead_sources (id),
  token_enc bytea,
  token_at timestamptz,
  status text NOT NULL CHECK (status IN ('active', 'needs_attention', 'disconnected')),
  problem text,
  -- A new person who DMs becomes a lead (the default), or waits in Not a lead yet.
  new_dm_creates_lead boolean NOT NULL DEFAULT true,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'disconnected') = (token_enc IS NULL))
);

-- Each delivery Meta sent, once (Meta retries for up to 36 hours): the same (account, key) is one row. The event is
-- encrypted while it waits and cleared once processed; the row stays so a late retry is still recognised. An intake
-- table, as whatsapp_events: no row-level security, never read by a route.
CREATE TABLE instagram_events (
  id bigserial PRIMARY KEY,
  account_ig_id text NOT NULL,
  event_key text NOT NULL CHECK (char_length(event_key) <= 200),
  kind text NOT NULL CHECK (kind IN ('message', 'postback', 'referral', 'reaction', 'seen', 'unsend', 'comment')),
  event_enc bytea,
  status text NOT NULL CHECK (status IN ('queued', 'done', 'error')),
  problem text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (account_ig_id, event_key)
);
CREATE INDEX instagram_events_queued ON instagram_events (received_at) WHERE status = 'queued';
CREATE INDEX instagram_events_received ON instagram_events (received_at);

-- A conversation: one person (their Instagram-scoped id on this account) and the account. On a lead, seen with the lead;
-- with no lead (Not a lead yet), seen by the account's owner and by whoever sees every lead. `last_in_at` is the
-- person's last message, reaction or tap (Meta's window); `ad_window_until` the 7 days after a first message from an
-- ad. A person who takes over pauses automation for this conversation.
CREATE TABLE instagram_threads (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES instagram_accounts (id) ON DELETE CASCADE,
  igsid text NOT NULL CHECK (char_length(igsid) BETWEEN 1 AND 64),
  lead_id uuid REFERENCES leads (id) ON DELETE SET NULL,
  username text,
  name text,
  last_in_at timestamptz,
  ad_window_until timestamptz,
  last_out_at timestamptz,
  last_message_at timestamptz,
  taken_over_by uuid REFERENCES users (id),
  taken_over_at timestamptz,
  -- How the person came: the trigger, keyword, post or ad (no message words).
  source jsonb NOT NULL DEFAULT '{}'::jsonb,
  profile_read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, igsid),
  CHECK ((taken_over_by IS NULL) = (taken_over_at IS NULL))
);
CREATE INDEX instagram_threads_lead ON instagram_threads (lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX instagram_threads_waiting ON instagram_threads (account_id, last_message_at DESC) WHERE lead_id IS NULL;
CREATE INDEX instagram_threads_recent ON instagram_threads (last_message_at DESC);

-- "Not a lead": that person never shows up in Not a lead yet again on that account.
CREATE TABLE instagram_ignored (
  account_id uuid NOT NULL REFERENCES instagram_accounts (id) ON DELETE CASCADE,
  igsid text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, igsid)
);

-- A comment on one of the business's posts or reels, with its one private reply (Meta: within 7 days of the comment).
CREATE TABLE instagram_comments (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES instagram_accounts (id) ON DELETE CASCADE,
  comment_id text NOT NULL UNIQUE,
  media_id text,
  media_type text,
  parent_id text,
  from_igsid text NOT NULL,
  from_username text,
  text text,
  ad_id text,
  live boolean NOT NULL DEFAULT false,
  at timestamptz NOT NULL,
  thread_id uuid REFERENCES instagram_threads (id) ON DELETE SET NULL,
  private_reply text NOT NULL DEFAULT 'none' CHECK (private_reply IN ('none', 'queued', 'sent', 'failed')),
  private_reply_at timestamptz,
  public_reply_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX instagram_comments_media ON instagram_comments (account_id, media_id, at DESC);
CREATE INDEX instagram_comments_thread ON instagram_comments (thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX instagram_comments_at ON instagram_comments (at);

-- A message LUME sends (a person's reply, a flow's step, a private reply to a comment), from Send until Meta took it,
-- or why it didn't. Seen exactly as its lead is. A flow's step is one row however often its job runs.
CREATE TABLE instagram_outbox (
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES instagram_threads (id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES instagram_accounts (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id),
  activity_id uuid,
  client_key uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('dm', 'private_reply')),
  comment_id text,
  text text CHECK (octet_length(text) <= 1000),
  media_id uuid,
  quick_replies jsonb,
  buttons jsonb,
  -- Meta's human agent tag: a person's reply after 24 hours, within 7 days. Never a flow's or LUME AI's.
  tag text CHECK (tag IN ('human_agent')),
  flow_run_id uuid,
  step_key text,
  status text NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'read', 'failed', 'cancelled')),
  mid text UNIQUE,
  reaction text,
  problem text,
  tries integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_key),
  UNIQUE (flow_run_id, step_key),
  CHECK ((kind = 'private_reply') = (comment_id IS NOT NULL)),
  CHECK ((flow_run_id IS NULL) = (step_key IS NULL)),
  CHECK (text IS NOT NULL OR media_id IS NOT NULL OR status IN ('failed', 'cancelled'))
);
CREATE INDEX instagram_outbox_thread ON instagram_outbox (thread_id, created_at);
CREATE INDEX instagram_outbox_lead ON instagram_outbox (lead_id);
CREATE INDEX instagram_outbox_open ON instagram_outbox (updated_at) WHERE status IN ('queued', 'sending');
-- One private reply per comment, whoever sends it: a second can never be queued.
CREATE UNIQUE INDEX instagram_outbox_one_private_reply ON instagram_outbox (comment_id)
  WHERE kind = 'private_reply' AND status NOT IN ('failed', 'cancelled');

-- A photo, video, voice note or file a person sent: fetched to this server (Meta's links expire), at most 25 MB, kept
-- once on disk in the same content-addressed store as WhatsApp's files. Seen as its conversation is.
CREATE TABLE instagram_media (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES instagram_accounts (id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES instagram_threads (id) ON DELETE CASCADE,
  lead_id uuid REFERENCES leads (id) ON DELETE CASCADE,
  mid text NOT NULL,
  position smallint NOT NULL DEFAULT 0,
  url text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'file')),
  mime text,
  size integer CHECK (size >= 0),
  sha256 text REFERENCES whatsapp_files (sha256) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('waiting', 'ready', 'too_large', 'failed', 'gone')),
  problem text,
  tries integer NOT NULL DEFAULT 0,
  retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mid, position),
  CHECK ((status = 'ready') = (sha256 IS NOT NULL))
);
CREATE INDEX instagram_media_thread ON instagram_media (thread_id);
CREATE INDEX instagram_media_waiting ON instagram_media (created_at) WHERE status = 'waiting';
CREATE INDEX instagram_media_sha256 ON instagram_media (sha256) WHERE sha256 IS NOT NULL;
-- The file store's count of what points at each file includes Instagram's media (0074's function, unchanged).
CREATE TRIGGER instagram_media_file_refs
  AFTER INSERT OR DELETE OR UPDATE OF sha256 ON instagram_media
  FOR EACH ROW
  EXECUTE FUNCTION lume_whatsapp_file_refs();

-- Who sees a conversation with no lead yet: the account's owner, and whoever sees every lead.
CREATE FUNCTION lume_instagram_account_seen(a uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM instagram_accounts x
     WHERE x.id = a AND (x.owner_user_id = lume_user() OR lume_scope() = 'all')
  )
$$;

ALTER TABLE instagram_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_threads FORCE ROW LEVEL SECURITY;
CREATE POLICY instagram_threads_seen ON instagram_threads
  USING (
    (lead_id IS NOT NULL AND EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id))
    OR (lead_id IS NULL AND lume_instagram_account_seen(account_id))
  )
  WITH CHECK (
    (lead_id IS NOT NULL AND EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id))
    OR (lead_id IS NULL AND lume_instagram_account_seen(account_id))
  );
CREATE POLICY backup_read ON instagram_threads FOR SELECT TO lume_readonly_backup USING (true);

ALTER TABLE instagram_ignored ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_ignored FORCE ROW LEVEL SECURITY;
CREATE POLICY instagram_ignored_seen ON instagram_ignored
  USING (lume_instagram_account_seen(account_id)) WITH CHECK (lume_instagram_account_seen(account_id));
CREATE POLICY backup_read ON instagram_ignored FOR SELECT TO lume_readonly_backup USING (true);

-- A comment carries a person's handle and words: seen by the account's owner and whoever sees every lead, or with the
-- conversation it led to.
ALTER TABLE instagram_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_comments FORCE ROW LEVEL SECURITY;
CREATE POLICY instagram_comments_seen ON instagram_comments
  USING (
    lume_instagram_account_seen(account_id)
    OR (thread_id IS NOT NULL AND EXISTS (SELECT 1 FROM instagram_threads t WHERE t.id = thread_id))
  )
  WITH CHECK (
    lume_instagram_account_seen(account_id)
    OR (thread_id IS NOT NULL AND EXISTS (SELECT 1 FROM instagram_threads t WHERE t.id = thread_id))
  );
CREATE POLICY backup_read ON instagram_comments FOR SELECT TO lume_readonly_backup USING (true);

ALTER TABLE instagram_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY instagram_outbox_seen ON instagram_outbox
  USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id))
  WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));
CREATE POLICY backup_read ON instagram_outbox FOR SELECT TO lume_readonly_backup USING (true);

ALTER TABLE instagram_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_media FORCE ROW LEVEL SECURITY;
CREATE POLICY instagram_media_seen ON instagram_media
  USING (EXISTS (SELECT 1 FROM instagram_threads t WHERE t.id = thread_id))
  WITH CHECK (EXISTS (SELECT 1 FROM instagram_threads t WHERE t.id = thread_id));
CREATE POLICY backup_read ON instagram_media FOR SELECT TO lume_readonly_backup USING (true);

-- Each account's new leads come in under its own lead source (type instagram), with that source's pipeline, stage and
-- owner rule, so Instagram leads show by source in analytics like every other source.
ALTER TABLE lead_sources DROP CONSTRAINT lead_sources_type;
ALTER TABLE lead_sources ADD CONSTRAINT lead_sources_type
  CHECK (type IN ('csv', 'google_sheet', 'webhook', 'manual', 'calendly', 'instagram'));

-- Connecting an account goes through the relay with its own kind.
ALTER TABLE oauth_connects DROP CONSTRAINT oauth_connects_kind;
ALTER TABLE oauth_connects ADD CONSTRAINT oauth_connects_kind
  CHECK (kind IN ('sheet', 'calendar', 'whatsapp', 'live_sheet', 'instagram'));

-- The ad a lead came from (a click-to-Instagram-Direct ad, a comment on an ad): for "which ads bring leads".
ALTER TABLE leads ADD COLUMN ad_id text CHECK (char_length(ad_id) <= 64);
CREATE INDEX leads_ad ON leads (ad_id) WHERE ad_id IS NOT NULL;

-- Live (as WhatsApp's, 0098): a conversation shows a new message and its status as they happen; never words.
CREATE FUNCTION lume_instagram_activity_notify() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.type = 'instagram_received' THEN
    PERFORM pg_notify('lume_instagram', json_build_object(
      'lead', NEW.lead_id, 'kind', 'in', 'owner', (SELECT owner_id FROM leads WHERE id = NEW.lead_id))::text);
  ELSE
    PERFORM pg_notify('lume_instagram', json_build_object('lead', NEW.lead_id, 'kind', 'out')::text);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER activities_instagram_live AFTER INSERT ON activities
  FOR EACH ROW WHEN (NEW.type IN ('instagram_received', 'instagram_sent'))
  EXECUTE FUNCTION lume_instagram_activity_notify();

CREATE FUNCTION lume_instagram_outbox_notify() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_notify('lume_instagram', json_build_object('lead', NEW.lead_id, 'kind', 'status')::text);
  RETURN NEW;
END $$;
CREATE TRIGGER instagram_outbox_live_insert AFTER INSERT ON instagram_outbox
  FOR EACH ROW EXECUTE FUNCTION lume_instagram_outbox_notify();
CREATE TRIGGER instagram_outbox_live_status AFTER UPDATE OF status ON instagram_outbox
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION lume_instagram_outbox_notify();

-- Instagram is the API's work alone (its queues run in the API, as lume_app): the worker has no use for any of it.
REVOKE ALL ON instagram_accounts, instagram_events, instagram_threads, instagram_ignored, instagram_comments,
  instagram_outbox, instagram_media FROM lume_worker;
REVOKE ALL ON SEQUENCE instagram_events_id_seq FROM lume_worker;
