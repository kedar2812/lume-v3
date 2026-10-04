-- Owner, 2026-10-05: the Calendar's Refresh card showed a bar that sat full the whole time. A sync now says how far
-- it has got (reading calendar 2 of 3, then saving), so the bar fills as the work does. Cleared when the sync ends.
ALTER TABLE calendar_connections ADD COLUMN sync_progress jsonb;
