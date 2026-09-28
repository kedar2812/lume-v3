-- 3A final review, Critical 2: pg_dump runs with row security on (backup.sh), so FORCE-RLS tables need a
-- read policy for the backup role, as every lead table has (0010_lead_rls.sql). Without it a backup holds
-- no follow-ups and no notifications.
CREATE POLICY backup_read ON tasks FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON notifications FOR SELECT TO lume_readonly_backup USING (true);
