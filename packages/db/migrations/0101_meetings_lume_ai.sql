-- LUME AI says yes to a call (owner 2026-11-02, docs/superpowers/specs/2026-11-02-lume-ai-books-calls.md): a meeting
-- booked in LUME itself, on the speaker's calendar, inside the times the business gave LUME AI. Its own id is its
-- external id (unique per owner as the others are); no connection, so a Google sync never touches it.
ALTER TABLE meetings DROP CONSTRAINT meetings_source;
ALTER TABLE meetings ADD CONSTRAINT meetings_source CHECK (source IN ('google', 'calendly', 'lume'));
ALTER TABLE meetings DROP CONSTRAINT meetings_matched_by;
ALTER TABLE meetings ADD CONSTRAINT meetings_matched_by
  CHECK (matched_by IN ('attendee', 'title', 'calendar', 'calendly', 'lume_ai'));
