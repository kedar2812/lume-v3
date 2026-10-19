-- Replying from LUME (plan W3a; spec 2026-10-18 §3.4): each message a person sends from a lead's WhatsApp tab, from
-- the moment they tap Send until Meta says it was read (or why it failed). Seen exactly as its lead is.
CREATE TABLE whatsapp_outbox (
  id uuid PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  number_id uuid NOT NULL REFERENCES whatsapp_numbers (id) ON DELETE CASCADE,
  -- Who sent it: the job sends as them, and the thread says so.
  user_id uuid NOT NULL REFERENCES users (id),
  -- The lead's thread entry (a whatsapp_sent activity) this message is.
  activity_id uuid,
  -- Made by the composer for each message: the same key twice (a double tap, a retry) is one message, never two.
  client_key uuid NOT NULL,
  text text CHECK (char_length(text) <= 4096),
  media_id uuid REFERENCES whatsapp_media (id) ON DELETE SET NULL,
  -- The follow-up it was sent from, done once Meta takes the message.
  task_id uuid,
  status text NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'read', 'failed')),
  wamid text UNIQUE,
  problem text,
  tries integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_key),
  CHECK (text IS NOT NULL OR media_id IS NOT NULL OR status = 'failed')
);
CREATE INDEX whatsapp_outbox_lead ON whatsapp_outbox (lead_id);
-- The minute sweep finds messages a lost job left behind.
CREATE INDEX whatsapp_outbox_open ON whatsapp_outbox (updated_at) WHERE status IN ('queued', 'sending');

ALTER TABLE whatsapp_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_outbox_seen ON whatsapp_outbox
  USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id))
  WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));
CREATE POLICY backup_read ON whatsapp_outbox FOR SELECT TO lume_readonly_backup USING (true);

-- A file uploaded to Meta, by number: Meta's media ids last 30 days, so a brochure sent to 150 leads is uploaded once
-- (kept 25 days). No lead data: a number, a file hash, Meta's id.
CREATE TABLE whatsapp_meta_uploads (
  number_id uuid NOT NULL REFERENCES whatsapp_numbers (id) ON DELETE CASCADE,
  sha256 text NOT NULL REFERENCES whatsapp_files (sha256) ON DELETE CASCADE,
  meta_media_id text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (number_id, sha256)
);

-- A file someone attached in the composer and hasn't sent yet: a draft, removed after a day if it never goes.
ALTER TABLE whatsapp_media
  ADD COLUMN draft boolean NOT NULL DEFAULT false,
  ADD COLUMN uploaded_by uuid REFERENCES users (id);
CREATE INDEX whatsapp_media_drafts ON whatsapp_media (created_at) WHERE draft;

REVOKE ALL ON whatsapp_outbox, whatsapp_meta_uploads FROM lume_worker;
