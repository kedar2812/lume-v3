-- WhatsApp files out of the database (2026-10-19, owner: "build them all"): each photo, voice note, video or document
-- is kept once on the server's disk, named by its SHA-256 (apps/api/src/modules/whatsapp/files.ts), so a brochure sent
-- to 150 leads is one file, the 6-hourly dumps stay small, and each file goes off-site once (backup-files.sh).

-- What's on disk. No lead data here (a hash and a size), so no row-level security: which media point at a file, and
-- who may see them, stays on whatsapp_media.
CREATE TABLE whatsapp_files (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint NOT NULL CHECK (size >= 0),
  -- How many whatsapp_media rows point here, kept by the trigger below: never counted with a query, which row-level
  -- security would answer for one person only. The hourly sweep removes a file at 0 refs.
  refs integer NOT NULL DEFAULT 0 CHECK (refs >= 0),
  -- Touched before every write: the sweep spares a file touched within the hour, so a fetch in flight never loses it.
  last_ref_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_files_unused ON whatsapp_files (last_ref_at) WHERE refs = 0;

-- Files gone from the server: the worker deletes their off-site copies 200 days later (older dumps still point at
-- them until then; the oldest kept dump is about 186 days old). A file that comes back is taken off this list.
CREATE TABLE whatsapp_files_gone (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  gone_at timestamptz NOT NULL DEFAULT now()
);

-- The off-site copies are named HMAC(salt, hash), not by their hash: someone who can list the backup remote and holds a
-- candidate file can't confirm this client had it. A random salt per server, kept here so a restore brings it back
-- and a master-key rotation never renames every copy. (Two v4 UUIDs: 244 bits from Postgres's strong random source.)
ALTER TABLE settings ADD COLUMN files_salt text NOT NULL DEFAULT (gen_random_uuid()::text || gen_random_uuid()::text);

-- Rows that held their bytes in the database (dev and e2e only: no client could connect WhatsApp before this, with no
-- Meta app yet) can't be moved by SQL; they say so instead.
ALTER TABLE whatsapp_media DROP CONSTRAINT whatsapp_media_check;
ALTER TABLE whatsapp_media DROP CONSTRAINT whatsapp_media_status_check;
UPDATE whatsapp_media SET status = 'failed', problem = 'Fetched before an update. It''s still on the phone.'
 WHERE status = 'ready';
ALTER TABLE whatsapp_media DROP COLUMN data;
ALTER TABLE whatsapp_media
  ADD COLUMN sha256 text REFERENCES whatsapp_files (sha256) ON DELETE RESTRICT,
  -- When a file that couldn't be kept (the disk full, the folder not writable) may be tried again: the minute sweep
  -- leaves it until then, so a full disk never has LUME fetching the same file from Meta every minute.
  ADD COLUMN retry_at timestamptz,
  ADD CONSTRAINT whatsapp_media_status_check
    CHECK (status IN ('waiting', 'ready', 'too_large', 'failed', 'removed')),
  ADD CONSTRAINT whatsapp_media_file_check CHECK ((status = 'ready') = (sha256 IS NOT NULL));
CREATE INDEX whatsapp_media_sha256 ON whatsapp_media (sha256) WHERE sha256 IS NOT NULL;
-- "Keep WhatsApp files for N months": the hourly sweep finds the old ones by age.
CREATE INDEX whatsapp_media_ready_age ON whatsapp_media (created_at) WHERE status = 'ready';

-- The count of media pointing at each file. SECURITY DEFINER: a lead's purge cascades to its media as whichever role
-- purges, and the count must follow whoever it is. Fixed search_path: pg_restore and the cascade run with others.
CREATE FUNCTION lume_whatsapp_file_refs() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.sha256 IS NOT NULL THEN
    -- Never below 0, and never an error: a count that drifted must not block a lead's purge. The FK below is the
    -- real guard (a file with media still on it can't be deleted); the sweep mends a count that's wrong.
    UPDATE whatsapp_files SET refs = greatest(refs - 1, 0) WHERE sha256 = OLD.sha256;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.sha256 IS NOT NULL THEN
    UPDATE whatsapp_files SET refs = refs + 1, last_ref_at = now() WHERE sha256 = NEW.sha256;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION lume_whatsapp_file_refs() FROM PUBLIC;
CREATE TRIGGER whatsapp_media_file_refs
  AFTER INSERT OR DELETE OR UPDATE OF sha256 ON whatsapp_media
  FOR EACH ROW
  EXECUTE FUNCTION lume_whatsapp_file_refs();

-- The worker's part: the off-site copies of files that went (it never reads what a file is, or who it's for).
REVOKE ALL ON whatsapp_files FROM lume_worker;
REVOKE INSERT, UPDATE ON whatsapp_files_gone FROM lume_worker;
