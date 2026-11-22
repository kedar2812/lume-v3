-- Instagram's "Not a lead yet" (2026-11-22; NEW_FEATURES_PLAN §4.3, plan 1A Task 5): a message from someone no lead
-- has yet, kept 14 days on its conversation until a person makes them a lead (the messages move onto the lead) or
-- ignores them. Seen as its conversation is: the account's owner and whoever sees every lead.
CREATE TABLE instagram_inbox (
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES instagram_threads (id) ON DELETE CASCADE,
  mid text NOT NULL UNIQUE,
  at timestamptz NOT NULL,
  text text,
  -- What came with it, as LUME read it (attachments, a story replied to or mentioned, a tap, an ad): no tokens.
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The person took it back (Instagram's unsend): its words are gone.
  unsent boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX instagram_inbox_thread ON instagram_inbox (thread_id, at);
CREATE INDEX instagram_inbox_created ON instagram_inbox (created_at);

ALTER TABLE instagram_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY instagram_inbox_seen ON instagram_inbox
  USING (EXISTS (SELECT 1 FROM instagram_threads t WHERE t.id = thread_id))
  WITH CHECK (EXISTS (SELECT 1 FROM instagram_threads t WHERE t.id = thread_id));
CREATE POLICY backup_read ON instagram_inbox FOR SELECT TO lume_readonly_backup USING (true);

REVOKE ALL ON instagram_inbox FROM lume_worker;
