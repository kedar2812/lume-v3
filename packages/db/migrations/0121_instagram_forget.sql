-- Meta's data deletion request for an Instagram account (2026-11-22; NEW_FEATURES_PLAN §7.2, plan 1A Task 7): the
-- business asked Meta that what LUME received about the account be deleted. The account is disconnected by the caller;
-- this removes what Instagram sent LUME for it: the words of the messages people sent (on leads, and waiting in Not a
-- lead yet), their files, its comments, and the names and usernames on its conversations. Leads themselves stay: they
-- are the business's own records. Activities are insert-only for every role, so this one function, owned by the table
-- owner, is the only way their words are taken out; it touches nothing but Instagram's own activity types.
CREATE FUNCTION lume_instagram_forget(acct uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  -- Every conversation of the account, whoever's lead it's on (this transaction only).
  PERFORM set_config('lume.lead_scope', 'all', true);
  UPDATE activities a
     SET payload = (a.payload - 'text' - 'attachments' - 'story' - 'tap' - 'referral') || '{"forgotten": true}'::jsonb
   WHERE a.type IN ('instagram_received', 'instagram_sent')
     AND (a.payload->>'accountId' = acct::text
          OR a.payload->>'threadId' IN (SELECT t.id::text FROM instagram_threads t WHERE t.account_id = acct));
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM instagram_inbox WHERE thread_id IN (SELECT id FROM instagram_threads WHERE account_id = acct);
  DELETE FROM instagram_media WHERE account_id = acct;
  DELETE FROM instagram_comments WHERE account_id = acct;
  UPDATE instagram_threads SET username = NULL, name = NULL, source = '{}'::jsonb WHERE account_id = acct;
  PERFORM set_config('lume.lead_scope', '', true);
  RETURN n;
END $$;
-- Row-level security is forced on activities for every role, the owner too: this one policy lets the owner (this
-- function, and migrations) change Instagram's own message activities, nothing else. No app role gets it.
CREATE POLICY activities_instagram_forget ON activities FOR UPDATE TO lume_owner
  USING (type IN ('instagram_received', 'instagram_sent'))
  WITH CHECK (type IN ('instagram_received', 'instagram_sent'));
REVOKE ALL ON FUNCTION lume_instagram_forget(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_instagram_forget(uuid) TO lume_app;
