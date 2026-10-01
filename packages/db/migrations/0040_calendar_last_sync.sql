-- 5D: Refresh says what the sync changed, and a Refresh asked while a sync runs is never lost.
-- last_sync: { at, added, moved, cancelled, changed } of the latest sync (at = when it started reading).
-- sync_requested_at: when someone last pressed Refresh; a sync that started before it leaves the
-- connection due at once instead of five minutes on.
ALTER TABLE calendar_connections ADD COLUMN last_sync jsonb, ADD COLUMN sync_requested_at timestamptz;
