-- Schedule a meeting (owner, 2026-11-13): a person books a call with a lead from its card or the Calendar, on their own
-- LUME calls calendar with a new Meet link. Kept as LUME AI's are (source 'lume', its own id as its external id, no
-- connection, so a Google sync never touches it), marked as a person's.
ALTER TABLE meetings DROP CONSTRAINT meetings_matched_by;
ALTER TABLE meetings ADD CONSTRAINT meetings_matched_by
  CHECK (matched_by IN ('attendee', 'title', 'calendar', 'calendly', 'lume_ai', 'lume'));
