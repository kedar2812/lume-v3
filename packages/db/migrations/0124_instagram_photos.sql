-- Instagram profile photos on leads (1B addendum, owner 2026-11-22). Meta gives a person's photo only once they've
-- written to the business, as a signed link that expires: LUME keeps its own copy in the file store WhatsApp and
-- Instagram media already use (0074), one per conversation, and checks it again a week after it last looked.
ALTER TABLE instagram_threads
  ADD COLUMN photo_sha256 text REFERENCES whatsapp_files (sha256) ON DELETE RESTRICT,
  ADD COLUMN photo_mime text CHECK (photo_mime IN ('image/jpeg', 'image/png', 'image/webp')),
  -- When LUME last asked Meta (a photo or none): the next message after 7 days asks again. Null: never asked.
  ADD COLUMN photo_checked_at timestamptz,
  ADD CONSTRAINT instagram_threads_photo_check CHECK ((photo_sha256 IS NULL) = (photo_mime IS NULL));
CREATE INDEX instagram_threads_photo ON instagram_threads (photo_sha256) WHERE photo_sha256 IS NOT NULL;

-- The file store's count of what points at each file includes these photos (0074's rule: never counted with a query
-- under row-level security; the foreign key is the real guard). Not column-specific: a purge's cascade clears the
-- photo through the trigger below, which a column list wouldn't see.
CREATE FUNCTION lume_instagram_photo_refs() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.photo_sha256 IS NOT NULL THEN
    UPDATE whatsapp_files SET refs = greatest(refs - 1, 0) WHERE sha256 = OLD.photo_sha256;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.photo_sha256 IS NOT NULL THEN
    UPDATE whatsapp_files SET refs = refs + 1, last_ref_at = now() WHERE sha256 = NEW.photo_sha256;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION lume_instagram_photo_refs() FROM PUBLIC;
CREATE TRIGGER instagram_threads_photo_refs_in
  AFTER INSERT ON instagram_threads FOR EACH ROW WHEN (NEW.photo_sha256 IS NOT NULL)
  EXECUTE FUNCTION lume_instagram_photo_refs();
CREATE TRIGGER instagram_threads_photo_refs_up
  AFTER UPDATE ON instagram_threads FOR EACH ROW WHEN (OLD.photo_sha256 IS DISTINCT FROM NEW.photo_sha256)
  EXECUTE FUNCTION lume_instagram_photo_refs();
CREATE TRIGGER instagram_threads_photo_refs_out
  AFTER DELETE ON instagram_threads FOR EACH ROW WHEN (OLD.photo_sha256 IS NOT NULL)
  EXECUTE FUNCTION lume_instagram_photo_refs();

-- Deleted with the lead: a purge sets the conversation's lead to null (0118), and its photo goes with it. Asked
-- afresh if the person writes again.
CREATE FUNCTION lume_instagram_thread_unlead() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.photo_sha256 := NULL;
  NEW.photo_mime := NULL;
  NEW.photo_checked_at := NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER instagram_threads_unlead
  BEFORE UPDATE OF lead_id ON instagram_threads FOR EACH ROW
  WHEN (OLD.lead_id IS NOT NULL AND NEW.lead_id IS NULL)
  EXECUTE FUNCTION lume_instagram_thread_unlead();

-- Meta's data deletion request forgets the photos too.
CREATE OR REPLACE FUNCTION lume_instagram_forget(acct uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('lume.lead_scope', 'all', true);
  UPDATE activities a
     SET payload = (a.payload - 'text' - 'attachments' - 'story' - 'tap' - 'referral') || '{"forgotten": true}'::jsonb
   WHERE a.type IN ('instagram_received', 'instagram_sent')
     AND (a.payload->>'accountId' = acct::text
          OR a.payload->>'threadId' IN (SELECT t.id::text FROM instagram_threads t WHERE t.account_id = acct));
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE instagram_flow_runs r SET state = jsonb_set(r.state, '{answers}', '{}'::jsonb)
   WHERE r.thread_id IN (SELECT t.id FROM instagram_threads t WHERE t.account_id = acct) AND r.state ? 'answers';
  DELETE FROM instagram_inbox WHERE thread_id IN (SELECT id FROM instagram_threads WHERE account_id = acct);
  DELETE FROM instagram_media WHERE account_id = acct;
  DELETE FROM instagram_comments WHERE account_id = acct;
  DELETE FROM instagram_events WHERE account_ig_id = (SELECT ig_user_id FROM instagram_accounts WHERE id = acct);
  UPDATE instagram_threads
     SET username = NULL, name = NULL, source = '{}'::jsonb, photo_sha256 = NULL, photo_mime = NULL,
         photo_checked_at = NULL
   WHERE account_id = acct;
  PERFORM set_config('lume.lead_scope', '', true);
  RETURN n;
END $$;
