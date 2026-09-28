-- Phase 3A (spec 2026-09-28-phase-3 §4): follow-ups, their reminders, and what they tell people.
CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  assignee_id uuid NOT NULL REFERENCES users (id),
  type text NOT NULL DEFAULT 'follow_up' CONSTRAINT tasks_type CHECK (type IN ('follow_up', 'whatsapp')),
  template_id uuid,
  title text NOT NULL CONSTRAINT tasks_title CHECK (char_length(title) BETWEEN 1 AND 200),
  note text CONSTRAINT tasks_note CHECK (note IS NULL OR char_length(note) <= 2000),
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CONSTRAINT tasks_status CHECK (status IN ('open', 'done', 'cancelled')),
  remind_minutes int[] NOT NULL DEFAULT '{0}',
  recurrence jsonb,
  series_id uuid NOT NULL,
  auto_rule_id uuid,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz,
  done_by uuid REFERENCES users (id),
  cancelled_at timestamptz,
  version int NOT NULL DEFAULT 1
);
CREATE INDEX tasks_mine ON tasks (assignee_id, status, due_at);
CREATE INDEX tasks_lead ON tasks (lead_id, status, due_at);
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
-- A follow-up is visible exactly when its lead is (spec §3 "Who sees what"; assignees must see the lead).
CREATE POLICY tasks_read ON tasks FOR SELECT USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));
CREATE POLICY tasks_create ON tasks FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));
CREATE POLICY tasks_update ON tasks FOR UPDATE USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));

CREATE TABLE scheduled_notifications (
  id bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  offset_minutes int NOT NULL CONSTRAINT sn_offset CHECK (offset_minutes BETWEEN 0 AND 43200),
  fire_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CONSTRAINT sn_status CHECK (status IN ('pending', 'fired', 'cancelled')),
  fired_at timestamptz,
  CONSTRAINT sn_once UNIQUE (task_id, offset_minutes)
);
CREATE INDEX sn_due ON scheduled_notifications (fire_at) WHERE status = 'pending';

CREATE TABLE notifications (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind text NOT NULL,
  task_id uuid REFERENCES tasks (id) ON DELETE SET NULL,
  lead_id uuid REFERENCES leads (id) ON DELETE SET NULL,
  title text NOT NULL,
  body text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX notifications_mine ON notifications (user_id, id DESC);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_own ON notifications USING (user_id = lume_user()) WITH CHECK (user_id = lume_user());

-- The worker only sweeps: old read notifications go (spec §4). It never reads a title or a follow-up.
REVOKE ALL ON tasks, scheduled_notifications, notifications FROM lume_worker;
REVOKE ALL ON SEQUENCE scheduled_notifications_id_seq, notifications_id_seq FROM lume_worker;
GRANT SELECT (id, read_at, created_at), DELETE ON notifications TO lume_worker;
CREATE POLICY notifications_sweep_read ON notifications FOR SELECT TO lume_worker USING (true);
CREATE POLICY notifications_sweep ON notifications FOR DELETE TO lume_worker USING (true);
