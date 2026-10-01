-- Phase 5A: a "Connect with Google" in progress is for a sheet or a calendar; each completes only as its kind.
ALTER TABLE oauth_connects ADD COLUMN kind text NOT NULL DEFAULT 'sheet'
  CONSTRAINT oauth_connects_kind CHECK (kind IN ('sheet', 'calendar'));
