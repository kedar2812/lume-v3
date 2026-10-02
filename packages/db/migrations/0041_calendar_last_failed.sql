-- 5D review: when the latest sync failed, so a Refresh can tell its own sync failed and say why,
-- rather than wait out a sync that won't run again for minutes.
ALTER TABLE calendar_connections ADD COLUMN last_failed_at timestamptz;
