-- Media (plan 2026-10-20-media-tab, Task 3): what LUME shows of a file before it's opened. A preview belongs to the
-- bytes, not to a library row: the same brochure added under two names is rendered once, and a WhatsApp attachment can
-- have one too. The thumbnail (and an Office file's PDF) are files in the shared store like any other, held by this row.
-- No lead data here (hashes and counts), so no row-level security: who may see a file is the rows that point at it.
CREATE TABLE file_previews (
  sha256       text        PRIMARY KEY REFERENCES whatsapp_files (sha256) ON DELETE CASCADE,
  state        text        NOT NULL DEFAULT 'pending',
  thumb_sha256 text        REFERENCES whatsapp_files (sha256),
  -- Word, Excel and PowerPoint, as LUME pages through them.
  pdf_sha256   text        REFERENCES whatsapp_files (sha256),
  pages        integer     CHECK (pages > 0),
  duration_ms  integer     CHECK (duration_ms > 0),
  width        integer     CHECK (width > 0),
  height       integer     CHECK (height > 0),
  tries        integer     NOT NULL DEFAULT 0 CHECK (tries >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- pending: not made yet; ready: made; none: nothing to make (a voice note, or no render service); failed: the
  -- render service couldn't, after its tries.
  CONSTRAINT file_previews_state_check CHECK (state IN ('pending', 'ready', 'none', 'failed')),
  CONSTRAINT file_previews_ready_check CHECK (state <> 'ready' OR thumb_sha256 IS NOT NULL)
);
-- The sweep's look for previews left waiting.
CREATE INDEX file_previews_pending ON file_previews (updated_at) WHERE state = 'pending';

-- A preview holds its thumbnail and PDF as a library file holds its file (0074's count), so the hourly sweep never
-- removes one in use. SECURITY DEFINER for the same reason: a file swept away cascades here as whichever role sweeps.
CREATE FUNCTION lume_file_preview_refs() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE whatsapp_files SET refs = greatest(refs - 1, 0)
     WHERE sha256 IN (OLD.thumb_sha256, OLD.pdf_sha256);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    UPDATE whatsapp_files SET refs = refs + 1, last_ref_at = now()
     WHERE sha256 IN (NEW.thumb_sha256, NEW.pdf_sha256);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION lume_file_preview_refs() FROM PUBLIC;
CREATE TRIGGER file_previews_file_refs
  AFTER INSERT OR DELETE OR UPDATE OF thumb_sha256, pdf_sha256 ON file_previews
  FOR EACH ROW
  EXECUTE FUNCTION lume_file_preview_refs();

REVOKE ALL ON file_previews FROM lume_worker;
