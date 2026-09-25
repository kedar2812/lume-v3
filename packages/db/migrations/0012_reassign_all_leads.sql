-- Disabling someone can hand every lead they own to a colleague (Settings -> People). The admin doing
-- it may not see all of those leads under their own scope, so this one statement widens the request's
-- lead scope to 'all', does the hand-off with its history rows, and puts the scope back before
-- returning. It changes nothing else, and the API audits the call.
CREATE FUNCTION reassign_all_leads(from_user uuid, to_user uuid, by_user uuid)
RETURNS integer LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  saved text := current_setting('lume.lead_scope', true);
  moved integer;
BEGIN
  PERFORM set_config('lume.lead_scope', 'all', true);
  WITH changed AS (
    UPDATE leads SET owner_id = to_user, version = version + 1, last_activity_at = now()
    WHERE owner_id = from_user AND deleted_at IS NULL
    RETURNING id
  ), logged AS (
    INSERT INTO lead_assignment_history (lead_id, from_user_id, to_user_id, changed_by, reason)
    SELECT id, from_user, to_user, by_user, 'owner_disabled' FROM changed
    RETURNING 1
  )
  SELECT count(*) INTO moved FROM logged;
  PERFORM set_config('lume.lead_scope', coalesce(saved, ''), true);
  RETURN moved;
END $$;
REVOKE ALL ON FUNCTION reassign_all_leads(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reassign_all_leads(uuid, uuid, uuid) TO lume_app;
