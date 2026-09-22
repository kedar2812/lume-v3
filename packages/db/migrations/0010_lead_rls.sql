-- Report §7.4: row-level security, FORCEd so even the table owner is bound. Fails closed: with no
-- request scope (lume_scope() is NULL) nothing is visible.
-- pg_dump/pg_restore run with an empty search_path; policy helpers must not depend on the caller's.
ALTER FUNCTION lume_user() SET search_path = public, pg_temp;
ALTER FUNCTION lume_scope() SET search_path = public, pg_temp;
ALTER FUNCTION lume_team_members() SET search_path = public, pg_temp;
ALTER FUNCTION lead_contact_keys_sync() SET search_path = public, pg_temp;

CREATE FUNCTION lume_can_see_owner(owner uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(
    lume_scope() = 'all'
    OR (owner IS NOT NULL AND lume_user() IS NOT NULL AND (
      owner = lume_user()
      OR (lume_scope() = 'team' AND owner = ANY (lume_team_members()))
    )),
    false)
$$;

-- Handing a lead to someone else: Postgres checks an UPDATE's new row against the read policy too, so a
-- reassignment that takes the lead out of the caller's scope needs this transaction-local allowance for
-- exactly that lead. The update policy still demands the caller could see the lead beforehand.
CREATE FUNCTION lume_handoff_lead() RETURNS uuid LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT NULLIF(current_setting('lume.handoff_lead', true), '')::uuid
$$;

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE ROW LEVEL SECURITY;
CREATE POLICY leads_read ON leads FOR SELECT USING (lume_can_see_owner(owner_id) OR id = lume_handoff_lead());
CREATE POLICY leads_create ON leads FOR INSERT WITH CHECK (lume_can_see_owner(owner_id));
-- Update only what you can see; the new row need not stay visible (handing a lead away, see lume_handoff_lead).
CREATE POLICY leads_update ON leads FOR UPDATE USING (lume_can_see_owner(owner_id)) WITH CHECK (lume_user() IS NOT NULL);
-- No DELETE policy: leads are soft-deleted.

-- Children inherit the lead's visibility (the subquery is itself filtered by leads_read).
ALTER TABLE lead_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_tags FORCE ROW LEVEL SECURITY;
CREATE POLICY lead_tags_read ON lead_tags FOR SELECT USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));
CREATE POLICY lead_tags_create ON lead_tags FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));
CREATE POLICY lead_tags_remove ON lead_tags FOR DELETE USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));

ALTER TABLE lead_stage_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_stage_history FORCE ROW LEVEL SECURITY;
CREATE POLICY lead_stage_history_read ON lead_stage_history FOR SELECT USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));
CREATE POLICY lead_stage_history_create ON lead_stage_history FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));

ALTER TABLE lead_assignment_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_assignment_history FORCE ROW LEVEL SECURITY;
CREATE POLICY lead_assignment_history_read ON lead_assignment_history FOR SELECT USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));
CREATE POLICY lead_assignment_history_create ON lead_assignment_history FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));

ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities FORCE ROW LEVEL SECURITY;
CREATE POLICY activities_read ON activities FOR SELECT USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));
CREATE POLICY activities_create ON activities FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));

-- Backups: pg_dump --enable-row-security as lume_readonly_backup dumps everything through these.
CREATE POLICY backup_read ON leads FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON lead_tags FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON lead_stage_history FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON lead_assignment_history FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON activities FOR SELECT TO lume_readonly_backup USING (true);
