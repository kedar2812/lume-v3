-- Autopilot (spec 2026-10-19 §1–§3): LUME AI working a selection of leads on WhatsApp, on the server. A run is the
-- business's choices at its start (goal, speaker, number, permissions, follow-up days, cap); each lead in it has its own
-- state; asks wait for a person's tap; events feed the live view (ids and kinds only, never words).

CREATE TABLE autopilot_runs (
  id            uuid        PRIMARY KEY,
  name          text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  started_by    uuid        NOT NULL REFERENCES users (id),
  speaker_id    uuid        NOT NULL REFERENCES users (id),
  number_id     uuid        NOT NULL REFERENCES whatsapp_numbers (id) ON DELETE CASCADE,
  goal          jsonb       NOT NULL CHECK (goal ->> 'kind' IN ('stage', 'reply', 'brief')),
  permissions   jsonb       NOT NULL CHECK (jsonb_typeof(permissions) = 'object'),
  follow_up_days integer[]  NOT NULL,
  daily_cap     integer     CHECK (daily_cap BETWEEN 1 AND 10000),
  outside_hours text        NOT NULL CHECK (outside_hours IN ('reply_any_time', 'wait')),
  status        text        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'paused', 'ended')),
  pause_reason  text        CHECK (pause_reason IN ('person', 'month', 'quality', 'speaker', 'number')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  CHECK ((status = 'paused') = (pause_reason IS NOT NULL)),
  CHECK ((status = 'ended') = (ended_at IS NOT NULL))
);
CREATE INDEX autopilot_runs_running ON autopilot_runs (status) WHERE status <> 'ended';

CREATE TABLE autopilot_leads (
  run_id          uuid        NOT NULL REFERENCES autopilot_runs (id) ON DELETE CASCADE,
  lead_id         uuid        NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  state           text        NOT NULL CHECK (state IN ('up_next', 'writing', 'sent', 'replied', 'talking', 'ready',
                                                          'needs_you', 'stopped', 'with_you', 'skipped')),
  -- Why it's skipped, needs a person or stopped, in words.
  reason          text        CHECK (char_length(reason) <= 300),
  -- Ready for you / Needs you: { headline, quote } (§2).
  card            jsonb,
  -- In this run: one run per lead at a time (§3). False once the run ends, or the lead stops or was skipped.
  active          boolean     NOT NULL DEFAULT true,
  next_at         timestamptz,
  first_sent_at   timestamptz,
  last_sent_at    timestamptz,
  last_inbound_at timestamptz,
  follow_ups_sent integer     NOT NULL DEFAULT 0 CHECK (follow_ups_sent >= 0),
  -- What LUME AI is writing (the screen reveals it), and what it will send with it (template, values, files, updates).
  draft           text        CHECK (char_length(draft) <= 4096),
  draft_payload   jsonb,
  fails           integer     NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, lead_id)
);
CREATE UNIQUE INDEX autopilot_leads_one_run ON autopilot_leads (lead_id) WHERE active;
CREATE INDEX autopilot_leads_due ON autopilot_leads (run_id, next_at) WHERE active;

CREATE TABLE autopilot_asks (
  id          uuid        PRIMARY KEY,
  run_id      uuid        NOT NULL REFERENCES autopilot_runs (id) ON DELETE CASCADE,
  lead_id     uuid        NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  action      text        NOT NULL,
  payload     jsonb       NOT NULL,
  status      text        NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'approved', 'declined', 'gone')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_by  uuid        REFERENCES users (id),
  decided_at  timestamptz
);
CREATE INDEX autopilot_asks_waiting ON autopilot_asks (run_id) WHERE status = 'waiting';

CREATE TABLE autopilot_events (
  id      bigserial   PRIMARY KEY,
  run_id  uuid        NOT NULL REFERENCES autopilot_runs (id) ON DELETE CASCADE,
  lead_id uuid        REFERENCES leads (id) ON DELETE CASCADE,
  kind    text        NOT NULL CHECK (kind ~ '^[a-z_]{2,40}$'),
  data    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX autopilot_events_run ON autopilot_events (run_id, id);

-- A lead's rows are seen by whoever may see the lead, as its WhatsApp messages are; a run's own events by anyone signed in.
ALTER TABLE autopilot_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_leads FORCE ROW LEVEL SECURITY;
CREATE POLICY autopilot_leads_seen ON autopilot_leads
  USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id))
  WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));
CREATE POLICY backup_read ON autopilot_leads FOR SELECT TO lume_readonly_backup USING (true);

ALTER TABLE autopilot_asks ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_asks FORCE ROW LEVEL SECURITY;
CREATE POLICY autopilot_asks_seen ON autopilot_asks
  USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id))
  WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));
CREATE POLICY backup_read ON autopilot_asks FOR SELECT TO lume_readonly_backup USING (true);

ALTER TABLE autopilot_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_events FORCE ROW LEVEL SECURITY;
CREATE POLICY autopilot_events_seen ON autopilot_events
  USING (lead_id IS NULL OR EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id))
  WITH CHECK (lead_id IS NULL OR EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));
CREATE POLICY backup_read ON autopilot_events FOR SELECT TO lume_readonly_backup USING (true);
