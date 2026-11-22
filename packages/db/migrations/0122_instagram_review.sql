-- Instagram 1A review (2026-11-22): what the fresh review found, in the data.

-- The relay's own signature that this account was connected to this LUME: shown back when the relay rebuilds its
-- routing table, so no LUME can claim another's account. Not a secret to this server, but never sent anywhere else.
ALTER TABLE instagram_accounts ADD COLUMN relay_grant text;

-- A delivery that keeps failing (a bad body, a fault) is tried a few times, then left with its reason, never retried
-- every minute for ever.
ALTER TABLE instagram_events ADD COLUMN tries integer NOT NULL DEFAULT 0;

-- pg_dump reads with an empty search_path, so this policy helper names its schema (as 0048's): unqualified, the nightly
-- backup of a LUME with Instagram's tables failed. Qualified rather than SET search_path so the planner still inlines it.
CREATE OR REPLACE FUNCTION lume_instagram_account_seen(a uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.instagram_accounts x
     WHERE x.id = a AND (x.owner_user_id = public.lume_user() OR public.lume_scope() = 'all')
  )
$$;

-- Meta's data deletion request also takes the deliveries LUME still holds for the account (encrypted, waiting).
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
  DELETE FROM instagram_inbox WHERE thread_id IN (SELECT id FROM instagram_threads WHERE account_id = acct);
  DELETE FROM instagram_media WHERE account_id = acct;
  DELETE FROM instagram_comments WHERE account_id = acct;
  DELETE FROM instagram_events WHERE account_ig_id = (SELECT ig_user_id FROM instagram_accounts WHERE id = acct);
  UPDATE instagram_threads SET username = NULL, name = NULL, source = '{}'::jsonb WHERE account_id = acct;
  PERFORM set_config('lume.lead_scope', '', true);
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION lume_instagram_forget(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_instagram_forget(uuid) TO lume_app;
