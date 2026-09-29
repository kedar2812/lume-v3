-- Phase 4C (plan 2026-09-29-phase-4c-send-queue): the send queue — a person's run through a list of leads,
-- one message each — and Settings → Messages (its size and the daily cap).

ALTER TABLE settings ADD COLUMN messaging jsonb NOT NULL DEFAULT '{}';

CREATE TABLE send_queues (
  id                  uuid        PRIMARY KEY,
  user_id             uuid        NOT NULL REFERENCES users (id),
  -- The version planned with (4A): an edit mid-run never changes what was planned. Null: their own words.
  template_version_id uuid        REFERENCES template_versions (id),
  source              text        NOT NULL CHECK (source ~ '^(view:[0-9a-f-]{36}|selection)$'),
  -- Why these leads: the view's name when the run started, or "Your selection".
  source_name         text        NOT NULL CHECK (length(source_name) BETWEEN 1 AND 80),
  status              text        NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'paused', 'finished', 'cancelled')),
  paused_reason       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz
);
-- One run open at a time per person (plan ruling R1).
CREATE UNIQUE INDEX send_queues_one_open ON send_queues (user_id) WHERE status IN ('active', 'paused');

CREATE TABLE send_queue_items (
  queue_id      uuid        NOT NULL REFERENCES send_queues (id) ON DELETE CASCADE,
  position      integer     NOT NULL CHECK (position >= 0),
  lead_id       uuid        NOT NULL REFERENCES leads (id),
  status        text        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'sending', 'sent', 'not_sent', 'skipped')),
  reason        text,
  text_override text        CHECK (text_override IS NULL OR length(text_override) BETWEEN 1 AND 4096),
  done_at       timestamptz,
  PRIMARY KEY (queue_id, position),
  UNIQUE (queue_id, lead_id)
);

-- A run is its person's alone; its items go with it. (Leads keep their own row-level security: a lead the
-- person can no longer see is skipped at send time, with its reason.)
ALTER TABLE send_queues ENABLE ROW LEVEL SECURITY;
ALTER TABLE send_queues FORCE ROW LEVEL SECURITY;
CREATE POLICY send_queues_own ON send_queues USING (user_id = lume_user()) WITH CHECK (user_id = lume_user());
ALTER TABLE send_queue_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE send_queue_items FORCE ROW LEVEL SECURITY;
CREATE POLICY send_queue_items_own ON send_queue_items
  USING (EXISTS (SELECT 1 FROM send_queues q WHERE q.id = queue_id))
  WITH CHECK (EXISTS (SELECT 1 FROM send_queues q WHERE q.id = queue_id));
-- pg_dump runs with row security on: backups must hold every run (the 3A lesson).
CREATE POLICY backup_read ON send_queues FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON send_queue_items FOR SELECT TO lume_readonly_backup USING (true);
REVOKE ALL ON send_queues, send_queue_items FROM lume_worker;
