-- LUME makes the Meet link (owner 2026-11-02, docs/superpowers/specs/2026-11-03-lume-makes-the-meet-link.md): a
-- person's calendar connection may add LUME AI's calls to their Google Calendar, when they gave LUME that permission
-- (calendar.app.created) on its own consent. Off for every connection made before, and for any read-only connect.
-- calls_calendar_id: the calendar LUME made for them ("LUME calls"), the only one it may add events to; kept through a
-- read-only reconnect, so allowing it again uses the same calendar.
ALTER TABLE calendar_connections
  ADD COLUMN adds_events boolean NOT NULL DEFAULT false,
  ADD COLUMN calls_calendar_id text;
