-- Review 2026-11-18: 0114's gate was written for every command, so while it named a follow-up a caller could also
-- delete or make notices of it in other people's bells. It only ever needs to find them and mark them read.
DROP POLICY notifications_settle ON notifications;
CREATE POLICY notifications_settle_find ON notifications FOR SELECT
  USING (task_id = lume_settle_task());
CREATE POLICY notifications_settle ON notifications FOR UPDATE
  USING (task_id = lume_settle_task())
  WITH CHECK (task_id = lume_settle_task());
