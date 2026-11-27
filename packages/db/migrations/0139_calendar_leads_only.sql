-- Only leads' calls (owner 2026-11-27: "lume has to fetch data relevant to leads only, nothing else related to current
-- clients or personal details"). From here a Google event is a meeting only when it's with a lead who wasn't already a
-- customer; the title words and calendars only narrow that.
--
-- Migrations run as the tables' owner, which row-level security binds only while it's FORCEd: the clean-up below runs
-- with it lifted for these two tables, inside this migration's own transaction, and FORCE comes back before the end.
ALTER TABLE meetings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE calendar_connections NO FORCE ROW LEVEL SECURITY;

-- A meeting someone linked to a lead by hand (Link to a lead, recorded as meeting.attached) is marked as theirs:
-- the rules never take it away.
ALTER TABLE meetings DROP CONSTRAINT meetings_matched_by;
ALTER TABLE meetings ADD CONSTRAINT meetings_matched_by
  CHECK (matched_by IN ('attendee', 'title', 'calendar', 'calendly', 'lume_ai', 'lume', 'person'));
UPDATE meetings SET matched_by = 'person'
 WHERE source = 'google' AND lead_id IS NOT NULL
   AND id::text IN (SELECT entity_id FROM audit_log WHERE action = 'meeting.attached' AND entity_type = 'meeting');

-- What Google brought in with no lead and nothing recorded on it was never a lead's: it goes. A meeting with an
-- outcome logged is history someone wrote, and stays.
DELETE FROM meetings
 WHERE source = 'google' AND lead_id IS NULL AND status IN ('scheduled', 'cancelled') AND outcome_at IS NULL;

-- Title words and calendars saved before meant "bring these in too"; they now mean "only these". Nobody chose that, so
-- they're cleared: narrowing is something an admin turns on in Settings → Calendar.
UPDATE settings
   SET calendar = jsonb_set(calendar, '{rules}', '{"attendeeIsLead": true, "titleWords": [], "calendarIds": []}'::jsonb)
 WHERE calendar ? 'rules';

-- Every connection reads its whole window again at its next sync, so the new rule decides every event it keeps.
UPDATE calendar_connections
   SET calendars = COALESCE(
         (SELECT jsonb_agg(c - 'fullAt') FROM jsonb_array_elements(calendars) AS c),
         '[]'::jsonb
       ),
       next_sync_at = now();

ALTER TABLE meetings FORCE ROW LEVEL SECURITY;
ALTER TABLE calendar_connections FORCE ROW LEVEL SECURITY;
