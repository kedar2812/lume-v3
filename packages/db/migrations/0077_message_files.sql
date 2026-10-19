-- WhatsApp W3b-1 (plan 2026-10-19-whatsapp-file-library): the business's file library. Brochures, price lists and work
-- photos, kept once and sent from any lead. Each row points at a file in the shared store (whatsapp_files, 0074), so a
-- library file is stored, backed up and pruned exactly like a WhatsApp attachment, once however many times it's sent.
-- Configuration (like templates): no lead data, so no row-level security; written only through templates.manage routes.
CREATE TABLE message_files (
  id          uuid        PRIMARY KEY,
  sha256      text        NOT NULL REFERENCES whatsapp_files (sha256),
  name        text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  mime        text        NOT NULL,
  kind        text        NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'document')),
  size        bigint      NOT NULL CHECK (size > 0),
  -- The share link: its token sealed with the instance's key (to show it again) and hashed (to find it). Null until
  -- the link is first turned on; turning it off keeps the token, so turning it on again gives the same link.
  link_hash   text        UNIQUE CHECK (link_hash ~ '^[0-9a-f]{64}$'),
  link_enc    bytea,
  link_on     boolean     NOT NULL DEFAULT false,
  opens       integer     NOT NULL DEFAULT 0 CHECK (opens >= 0),
  created_by  uuid        REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CHECK ((link_hash IS NULL) = (link_enc IS NULL)),
  CHECK (NOT link_on OR link_hash IS NOT NULL)
);
CREATE UNIQUE INDEX message_files_live_name ON message_files (lower(name)) WHERE archived_at IS NULL;

-- A library file holds its stored file like a WhatsApp attachment does (the trigger function from 0074), so the hourly
-- sweep never removes a file the library still has; archiving keeps the row, and so keeps the file.
CREATE TRIGGER message_files_file_refs
  AFTER INSERT OR DELETE OR UPDATE OF sha256 ON message_files
  FOR EACH ROW
  EXECUTE FUNCTION lume_whatsapp_file_refs();

REVOKE ALL ON message_files FROM lume_worker;
