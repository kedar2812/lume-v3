-- Phase 7A (spec 2026-10-03-phase-7-scale-design §7A.1): the same visibility rules, with each request setting
-- read once per query (a scalar subquery becomes an InitPlan) instead of through lume_can_see_owner on every row.
-- That function can't be inlined (its SET search_path clause), and at 200,000 leads it cost 1.4 s of a 1.6 s
-- count. The meaning is unchanged, row for row, in every context (packages/db/src/rls.test.ts compares the two):
--   'all' sees every lead; any other scope sees its user's leads (never unassigned), 'team' adds the team's; a
--   hand-off sees its one lead (read only); with no settings, nothing. lume_can_see_owner stays for other callers.
DROP POLICY leads_read ON leads;
DROP POLICY leads_create ON leads;
DROP POLICY leads_update ON leads;

CREATE POLICY leads_read ON leads FOR SELECT USING (
  coalesce(
    (SELECT lume_scope()) = 'all'
    OR (owner_id IS NOT NULL AND (SELECT lume_user()) IS NOT NULL AND (
          owner_id = (SELECT lume_user())
          OR ((SELECT lume_scope()) = 'team' AND owner_id = ANY ((SELECT lume_team_members())::uuid[])))),
    false)
  OR id = (SELECT lume_handoff_lead())
);

CREATE POLICY leads_create ON leads FOR INSERT WITH CHECK (
  coalesce(
    (SELECT lume_scope()) = 'all'
    OR (owner_id IS NOT NULL AND (SELECT lume_user()) IS NOT NULL AND (
          owner_id = (SELECT lume_user())
          OR ((SELECT lume_scope()) = 'team' AND owner_id = ANY ((SELECT lume_team_members())::uuid[])))),
    false)
);

-- Update only what you can see; the new row need not stay visible (handing a lead away, see lume_handoff_lead).
CREATE POLICY leads_update ON leads FOR UPDATE USING (
  coalesce(
    (SELECT lume_scope()) = 'all'
    OR (owner_id IS NOT NULL AND (SELECT lume_user()) IS NOT NULL AND (
          owner_id = (SELECT lume_user())
          OR ((SELECT lume_scope()) = 'team' AND owner_id = ANY ((SELECT lume_team_members())::uuid[])))),
    false)
) WITH CHECK ((SELECT lume_user()) IS NOT NULL);
