-- Storage (owner 2026-11-23, plan 2026-11-23-storage-clean-up): what LUME keeps on the disk, and clearing what an admin
-- ticks. No lead data here: a clean-up's own record, and what makes the candidates quick to find.

-- When a preview was last opened: one not opened in 90 days can be cleared ('cleared': its thumbnail and pages let go,
-- the row kept so the 15-minute preview sweep doesn't make it again at once). The file library makes it again the
-- next time someone looks.
ALTER TABLE file_previews ADD COLUMN opened_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE file_previews DROP CONSTRAINT file_previews_state_check;
ALTER TABLE file_previews ADD CONSTRAINT file_previews_state_check
  CHECK (state IN ('pending', 'ready', 'none', 'failed', 'cleared'));
CREATE INDEX file_previews_opened ON file_previews (opened_at) WHERE state = 'ready';

-- An Instagram file a clean-up cleared: the message stays and says so, as WhatsApp's do ('removed', 0074/keep).
ALTER TABLE instagram_media DROP CONSTRAINT instagram_media_status_check;
ALTER TABLE instagram_media ADD CONSTRAINT instagram_media_status_check
  CHECK (status IN ('waiting', 'ready', 'too_large', 'failed', 'gone', 'over_limit', 'removed'));

-- Each clean-up: what it set out to clear, how far it got, who started it. One runs at a time.
CREATE TABLE storage_cleanups (
  id uuid PRIMARY KEY,
  kinds text[] NOT NULL CHECK (cardinality(kinds) BETWEEN 1 AND 5
    AND kinds <@ ARRAY['closed', 'trash', 'previews', 'library', 'old']::text[]),
  closed_months integer CHECK (closed_months IN (3, 6, 12, 24)),
  status text NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  files_planned integer NOT NULL DEFAULT 0 CHECK (files_planned >= 0),
  bytes_planned bigint NOT NULL DEFAULT 0 CHECK (bytes_planned >= 0),
  files_done integer NOT NULL DEFAULT 0 CHECK (files_done >= 0),
  bytes_done bigint NOT NULL DEFAULT 0 CHECK (bytes_done >= 0),
  problem text,
  started_by uuid REFERENCES users (id),
  started_at timestamptz NOT NULL DEFAULT now(),
  -- Last sign of work (start, each batch): a running clean-up quiet for long is picked up again by the hourly check.
  touched_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX storage_cleanups_one_running ON storage_cleanups ((true)) WHERE status = 'running';
CREATE INDEX storage_cleanups_started ON storage_cleanups (started_at DESC);
REVOKE ALL ON storage_cleanups FROM lume_worker;

-- The candidates, found without a scan of every message: leads in the trash (won and lost leads already have theirs,
-- leads_won_at and leads_lost_at), and the chat files on leads that are still kept.
CREATE INDEX leads_trashed ON leads (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX whatsapp_media_kept ON whatsapp_media (lead_id, created_at) WHERE status = 'ready';
CREATE INDEX instagram_media_kept ON instagram_media (lead_id, created_at) WHERE status = 'ready';
