-- WhatsApp replies, part 1 (spec 2026-10-18 §3–4; plan W1 Task 3): the business's connected numbers, Meta's
-- deliveries as they arrive, strangers waiting in "Not a lead yet", and the photos, voice notes and files people send.

-- Each connected number: whose it is (a person, or the business when null), who connected it (its jobs run as them),
-- and the client's business token, encrypted with the keyring. Configuration, no lead data: no row-level security; the
-- token column is never selected by a route.
CREATE TABLE whatsapp_numbers (
  id uuid PRIMARY KEY,
  phone_number_id text NOT NULL UNIQUE,
  waba_id text NOT NULL,
  display_phone text NOT NULL,
  verified_name text,
  owner_user_id uuid REFERENCES users (id),
  run_as uuid NOT NULL REFERENCES users (id),
  token_enc bytea,
  status text NOT NULL CHECK (status IN ('active', 'needs_attention', 'disconnected')),
  problem text,
  history_shared boolean NOT NULL DEFAULT false,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'disconnected') = (token_enc IS NULL))
);

-- Each message Meta delivered, once (Meta retries until it hears 200): the same (wamid, kind) is one row. The event is
-- encrypted while it waits and cleared once processed; the row stays 30 days so a late retry is still recognised.
-- An intake table, as webhook_events: no row-level security.
CREATE TABLE whatsapp_events (
  id bigserial PRIMARY KEY,
  phone_number_id text NOT NULL,
  wamid text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('received', 'sent', 'history_received', 'history_sent')),
  event_enc bytea,
  status text NOT NULL CHECK (status IN ('queued', 'done', 'error')),
  problem text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (wamid, kind)
);
CREATE INDEX whatsapp_events_queued ON whatsapp_events (received_at) WHERE status = 'queued';

-- "Not a lead yet" (§4.1): a message from a number no lead has, kept 14 days. Seen by the number's owner and by
-- whoever sees every lead (a business number's strangers: only them).
CREATE TABLE whatsapp_inbox (
  id uuid PRIMARY KEY,
  number_id uuid NOT NULL REFERENCES whatsapp_numbers (id) ON DELETE CASCADE,
  peer text NOT NULL,
  name text,
  wamid text NOT NULL UNIQUE,
  at timestamptz NOT NULL,
  text text,
  media_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_inbox_peer ON whatsapp_inbox (number_id, peer, at);
CREATE INDEX whatsapp_inbox_created ON whatsapp_inbox (created_at);

-- "Not a lead": that sender never shows up again on that number.
CREATE TABLE whatsapp_ignored (
  number_id uuid NOT NULL REFERENCES whatsapp_numbers (id) ON DELETE CASCADE,
  peer text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (number_id, peer)
);

-- A photo, voice note, video or document: fetched with the number's token to this server (Meta's links expire), at
-- most 25 MB. On a lead it's seen with the lead and goes with it; waiting in "Not a lead yet", with that rule.
CREATE TABLE whatsapp_media (
  id uuid PRIMARY KEY,
  number_id uuid NOT NULL REFERENCES whatsapp_numbers (id) ON DELETE CASCADE,
  meta_id text NOT NULL,
  lead_id uuid REFERENCES leads (id) ON DELETE CASCADE,
  inbox_id uuid REFERENCES whatsapp_inbox (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('image', 'audio', 'video', 'document', 'sticker')),
  mime text NOT NULL,
  filename text,
  voice boolean NOT NULL DEFAULT false,
  size integer CHECK (size >= 0),
  data bytea,
  status text NOT NULL CHECK (status IN ('waiting', 'ready', 'too_large', 'failed')),
  problem text,
  tries integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'ready') = (data IS NOT NULL))
);
CREATE INDEX whatsapp_media_lead ON whatsapp_media (lead_id);
CREATE INDEX whatsapp_media_waiting ON whatsapp_media (created_at) WHERE status = 'waiting';

CREATE FUNCTION lume_whatsapp_number_seen(n uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM whatsapp_numbers w
     WHERE w.id = n AND (w.owner_user_id = lume_user() OR lume_scope() = 'all')
  )
$$;

ALTER TABLE whatsapp_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_inbox_seen ON whatsapp_inbox
  USING (lume_whatsapp_number_seen(number_id)) WITH CHECK (lume_whatsapp_number_seen(number_id));
CREATE POLICY backup_read ON whatsapp_inbox FOR SELECT TO lume_readonly_backup USING (true);

ALTER TABLE whatsapp_ignored ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_ignored FORCE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_ignored_seen ON whatsapp_ignored
  USING (lume_whatsapp_number_seen(number_id)) WITH CHECK (lume_whatsapp_number_seen(number_id));
CREATE POLICY backup_read ON whatsapp_ignored FOR SELECT TO lume_readonly_backup USING (true);

ALTER TABLE whatsapp_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_media FORCE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_media_seen ON whatsapp_media
  USING (
    (lead_id IS NOT NULL AND EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id))
    OR (lead_id IS NULL AND lume_whatsapp_number_seen(number_id))
  )
  WITH CHECK (
    (lead_id IS NOT NULL AND EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id))
    OR (lead_id IS NULL AND lume_whatsapp_number_seen(number_id))
  );
CREATE POLICY backup_read ON whatsapp_media FOR SELECT TO lume_readonly_backup USING (true);

-- WhatsApp is the API's work alone (its queue runs in the API, as lume_app): the worker has no use for any of it.
REVOKE ALL ON whatsapp_numbers, whatsapp_events, whatsapp_inbox, whatsapp_ignored, whatsapp_media FROM lume_worker;
REVOKE ALL ON SEQUENCE whatsapp_events_id_seq FROM lume_worker;
