-- Phase 5A (spec 2026-10-01-phase-5-calendar §2.4): a person's Google Calendar connection, and the meetings
-- with leads LUME keeps from it. An event no rule keeps is never written anywhere (§2.2).

-- LUME's own sweeps (which connections are due; which meetings have ended) read across people, read-only.
CREATE FUNCTION lume_calendar_sweep() RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(current_setting('lume.calendar_sweep', true) = 'on', false)
$$;

CREATE TABLE calendar_connections (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE CONSTRAINT calendar_connections_one UNIQUE,
  google_email text NOT NULL,
  -- The sealed refresh token, bound to this row (calendar-connection:<id>), as a sheet's grant is.
  grant_enc bytea NOT NULL,
  -- [{ id, name, chosen, syncToken }]
  calendars jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active'
    CONSTRAINT calendar_connections_status CHECK (status IN ('active', 'needs_reconnect')),
  last_synced_at timestamptz,
  next_sync_at timestamptz NOT NULL DEFAULT now(),
  failures int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calendar_connections_due ON calendar_connections (next_sync_at) WHERE status = 'active';
ALTER TABLE calendar_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY calendar_connections_read ON calendar_connections FOR SELECT
  USING (user_id = lume_user() OR lume_calendar_sweep());
CREATE POLICY calendar_connections_create ON calendar_connections FOR INSERT WITH CHECK (user_id = lume_user());
CREATE POLICY calendar_connections_update ON calendar_connections FOR UPDATE
  USING (user_id = lume_user()) WITH CHECK (user_id = lume_user());
CREATE POLICY calendar_connections_delete ON calendar_connections FOR DELETE USING (user_id = lume_user());
CREATE POLICY backup_read ON calendar_connections FOR SELECT TO lume_readonly_backup USING (true);

CREATE TABLE meetings (
  id uuid PRIMARY KEY,
  -- Empty: an unlinked meeting (a title word or a chosen calendar kept it), its owner's to attach.
  lead_id uuid REFERENCES leads (id) ON DELETE CASCADE,
  -- Whose calendar it's on.
  owner_id uuid NOT NULL REFERENCES users (id),
  -- Disconnecting takes every meeting the connection brought; Calendly's (5B) have none.
  connection_id uuid REFERENCES calendar_connections (id) ON DELETE CASCADE,
  source text NOT NULL CONSTRAINT meetings_source CHECK (source IN ('google', 'calendly')),
  external_id text NOT NULL,
  calendar_id text,
  matched_by text NOT NULL CONSTRAINT meetings_matched_by CHECK (matched_by IN ('attendee', 'title', 'calendar', 'calendly')),
  title text NOT NULL CONSTRAINT meetings_title CHECK (char_length(title) <= 1000),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CONSTRAINT meetings_ends CHECK (ends_at >= starts_at),
  link text CONSTRAINT meetings_link CHECK (link IS NULL OR char_length(link) <= 2000),
  location text CONSTRAINT meetings_location CHECK (location IS NULL OR char_length(location) <= 1000),
  status text NOT NULL DEFAULT 'scheduled'
    CONSTRAINT meetings_status CHECK (status IN ('scheduled', 'cancelled', 'completed', 'no_show', 'rescheduled')),
  outcome_note text CONSTRAINT meetings_outcome_note CHECK (outcome_note IS NULL OR char_length(outcome_note) <= 2000),
  outcome_at timestamptz,
  outcome_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  CONSTRAINT meetings_once UNIQUE (source, owner_id, external_id)
);
CREATE INDEX meetings_owner ON meetings (owner_id, starts_at);
CREATE INDEX meetings_lead ON meetings (lead_id, starts_at) WHERE lead_id IS NOT NULL;
CREATE INDEX meetings_connection ON meetings (connection_id) WHERE connection_id IS NOT NULL;
ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE meetings FORCE ROW LEVEL SECURITY;
-- Linked: seen exactly when its lead is (as a follow-up). Unlinked: its owner's alone.
CREATE POLICY meetings_read ON meetings FOR SELECT USING (
  CASE WHEN lead_id IS NULL THEN owner_id = lume_user()
       ELSE EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id) END
  OR lume_calendar_sweep()
);
CREATE POLICY meetings_create ON meetings FOR INSERT WITH CHECK (
  owner_id = lume_user() AND (lead_id IS NULL OR EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id))
);
CREATE POLICY meetings_update ON meetings FOR UPDATE
  USING (
    CASE WHEN lead_id IS NULL THEN owner_id = lume_user()
         ELSE EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id) END
  )
  WITH CHECK (
    CASE WHEN lead_id IS NULL THEN owner_id = lume_user()
         ELSE EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id) END
  );
CREATE POLICY meetings_delete ON meetings FOR DELETE USING (owner_id = lume_user());
CREATE POLICY backup_read ON meetings FOR SELECT TO lume_readonly_backup USING (true);

-- The worker has no business with either: LUME's sync runs in the API process (as sheets do).
REVOKE ALL ON calendar_connections, meetings FROM lume_worker;

-- Settings → Calendar: which events are meetings with leads (§2.2). Only "an attendee is a lead" starts on.
ALTER TABLE settings ADD COLUMN calendar jsonb NOT NULL
  DEFAULT '{"rules":{"attendeeIsLead":true,"titleWords":[],"calendarIds":[]}}'::jsonb;
