-- Review 2026-11-17 (night): a follow-up done, cancelled, moved or handed on left two kinds of notice waiting in other
-- people's bells: a manager's "Asha's follow-up is 30 h overdue" (whose Remind them then failed), and "Maya gave you a
-- follow-up" for someone it's no longer theirs. Notifications are each person's own (0021), so settling another
-- person's goes through this gate, as LUME's calendar sweep does (0035): only the one follow-up's rows, only while the
-- setting names it, and only ever marked read.
CREATE FUNCTION lume_settle_task() RETURNS uuid LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT NULLIF(current_setting('lume.settle_task', true), '')::uuid
$$;

CREATE POLICY notifications_settle ON notifications
  USING (task_id = lume_settle_task())
  WITH CHECK (task_id = lume_settle_task());

-- Its escalations (stale once it's done, moved or handed on), and "you were given it" for anyone it isn't now with.
-- Returns whose bells changed, so each can be told. Settings put back as they were.
CREATE FUNCTION lume_settle_task_notices(p_task uuid)
RETURNS SETOF uuid
LANGUAGE plpgsql VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  was_scope text := current_setting('lume.lead_scope', true);
  was_task text := current_setting('lume.settle_task', true);
BEGIN
  PERFORM set_config('lume.lead_scope', 'all', true);
  PERFORM set_config('lume.settle_task', p_task::text, true);
  RETURN QUERY
    UPDATE notifications n SET read_at = now()
     WHERE n.task_id = p_task AND n.read_at IS NULL
       AND (n.kind = 'task_escalated'
            OR (n.kind = 'follow_up_assigned'
                AND NOT EXISTS (SELECT 1 FROM tasks t
                                 WHERE t.id = p_task AND t.status = 'open' AND t.assignee_id = n.user_id)))
    RETURNING n.user_id;
  PERFORM set_config('lume.settle_task', coalesce(was_task, ''), true);
  PERFORM set_config('lume.lead_scope', coalesce(was_scope, ''), true);
END;
$$;
