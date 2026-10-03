-- Phase 7A (Task 5): the stage strip's counts, kept by LUME instead of counted on every load. At 1,000,000 leads a
-- live count took 386 ms (everyone's) and 363 ms (a team lead's), and it grows with the leads.
--
-- Counts per (pipeline, stage, owner) live in two tables. Every statement that changes leads only appends its net
-- change to lead_count_deltas: no shared row is updated, so no writer ever waits on another or deadlocks with one
-- (7A review: an upserted counter row became a hot lock for intake and bulk alike). Once a minute LUME folds the
-- deltas into lead_counts (lume_lead_counts_rollup). lead_counts_now adds the two: the counts, always exact.
-- Counts filtered only by pipeline, owner or stage read it; any other filter still counts live.
CREATE TABLE lead_counts (
  pipeline_id uuid           NOT NULL,
  stage_id    uuid           NOT NULL,
  owner_id    uuid,
  n           bigint         NOT NULL DEFAULT 0,
  value       numeric(20, 2) NOT NULL DEFAULT 0
);
-- Unassigned leads (owner null) are one row per stage, not one per lead.
CREATE UNIQUE INDEX lead_counts_key ON lead_counts (pipeline_id, stage_id, owner_id) NULLS NOT DISTINCT;
CREATE INDEX lead_counts_owner ON lead_counts (owner_id, pipeline_id);

CREATE TABLE lead_count_deltas (
  id          bigserial      PRIMARY KEY,
  pipeline_id uuid           NOT NULL,
  stage_id    uuid           NOT NULL,
  owner_id    uuid,
  n           bigint         NOT NULL,
  value       numeric(20, 2) NOT NULL
);
CREATE INDEX lead_count_deltas_owner ON lead_count_deltas (owner_id, pipeline_id);

-- Read as leads are: everyone's counts for 'all' (unassigned included), your own, your team's. LUME writes both
-- tables from the triggers and the rollup below (definer functions); the app may only read them. Not FORCEd: the
-- definer functions write as the owner.
-- Schema-qualified: pg_dump reads with an empty search_path, and a SET clause would stop the planner inlining it.
CREATE FUNCTION lume_sees_owner(owner uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT public.lume_scope()) = 'all'
    OR (owner IS NOT NULL AND (SELECT public.lume_user()) IS NOT NULL AND (
          owner = (SELECT public.lume_user())
          OR ((SELECT public.lume_scope()) = 'team' AND owner = ANY ((SELECT public.lume_team_members())::uuid[])))),
    false)
$$;
ALTER TABLE lead_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_count_deltas ENABLE ROW LEVEL SECURITY;
CREATE POLICY lead_counts_read ON lead_counts FOR SELECT USING (lume_sees_owner(owner_id));
CREATE POLICY lead_count_deltas_read ON lead_count_deltas FOR SELECT USING (lume_sees_owner(owner_id));
CREATE POLICY backup_read ON lead_counts FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON lead_count_deltas FOR SELECT TO lume_readonly_backup USING (true);
REVOKE ALL ON lead_counts, lead_count_deltas FROM lume_app, lume_worker;
GRANT SELECT ON lead_counts, lead_count_deltas TO lume_app;

-- The counts now: base plus pending deltas, under each table's own row-level security (security_invoker).
CREATE VIEW lead_counts_now WITH (security_invoker = true) AS
  SELECT pipeline_id, stage_id, owner_id, sum(n)::bigint AS n, sum(value)::numeric(20, 2) AS value
    FROM (SELECT pipeline_id, stage_id, owner_id, n, value FROM lead_counts
          UNION ALL
          SELECT pipeline_id, stage_id, owner_id, n, value FROM lead_count_deltas) c
   GROUP BY pipeline_id, stage_id, owner_id;
REVOKE ALL ON lead_counts_now FROM lume_app, lume_worker;
GRANT SELECT ON lead_counts_now TO lume_app;

-- One statement's change to leads, as net changes per (pipeline, stage, owner): live leads in minus live leads out.
-- Appended only; a statement that changes nothing counted appends nothing.
CREATE FUNCTION lead_counts_after_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO lead_count_deltas (pipeline_id, stage_id, owner_id, n, value)
  SELECT pipeline_id, stage_id, owner_id, count(*), coalesce(sum(value), 0)
    FROM new_rows WHERE deleted_at IS NULL GROUP BY 1, 2, 3;
  RETURN NULL;
END $$;

CREATE FUNCTION lead_counts_after_update() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO lead_count_deltas (pipeline_id, stage_id, owner_id, n, value)
  SELECT pipeline_id, stage_id, owner_id, sum(dn), sum(dv) FROM (
    SELECT pipeline_id, stage_id, owner_id, 1 AS dn, coalesce(value, 0) AS dv FROM new_rows WHERE deleted_at IS NULL
    UNION ALL
    SELECT pipeline_id, stage_id, owner_id, -1, -coalesce(value, 0) FROM old_rows WHERE deleted_at IS NULL
  ) d
  GROUP BY 1, 2, 3 HAVING sum(dn) <> 0 OR sum(dv) <> 0;
  RETURN NULL;
END $$;

CREATE FUNCTION lead_counts_after_delete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO lead_count_deltas (pipeline_id, stage_id, owner_id, n, value)
  SELECT pipeline_id, stage_id, owner_id, -count(*), -coalesce(sum(value), 0)
    FROM old_rows WHERE deleted_at IS NULL GROUP BY 1, 2, 3;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION lead_counts_after_insert(), lead_counts_after_update(), lead_counts_after_delete() FROM PUBLIC;
CREATE TRIGGER lead_counts_insert AFTER INSERT ON leads REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION lead_counts_after_insert();
CREATE TRIGGER lead_counts_update AFTER UPDATE ON leads REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION lead_counts_after_update();
CREATE TRIGGER lead_counts_delete AFTER DELETE ON leads REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION lead_counts_after_delete();

-- Fold the deltas into lead_counts: one rollup at a time (a second returns at once), keys in order. Deltas appended
-- while it runs (by transactions it can't see yet) stay for the next one, so nothing is lost or counted twice.
CREATE FUNCTION lume_lead_counts_rollup() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE folded integer;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('lume_lead_counts_rollup')) THEN RETURN 0; END IF;
  WITH taken AS (DELETE FROM lead_count_deltas RETURNING pipeline_id, stage_id, owner_id, n, value),
       sums AS (SELECT pipeline_id, stage_id, owner_id, sum(n) AS n, sum(value) AS value, count(*) AS rows
                  FROM taken GROUP BY 1, 2, 3),
       applied AS (
         INSERT INTO lead_counts AS c (pipeline_id, stage_id, owner_id, n, value)
         SELECT pipeline_id, stage_id, owner_id, n, value FROM sums ORDER BY 1, 2, 3
         ON CONFLICT (pipeline_id, stage_id, owner_id) DO UPDATE SET n = c.n + EXCLUDED.n, value = c.value + EXCLUDED.value
         RETURNING 1)
  SELECT coalesce(sum(rows), 0)::integer INTO folded FROM sums;
  RETURN folded;
END $$;
REVOKE ALL ON FUNCTION lume_lead_counts_rollup() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_lead_counts_rollup() TO lume_app;

-- The backfill: every live lead, as the table owner with every lead in scope.
SELECT set_config('lume.lead_scope', 'all', true);
INSERT INTO lead_counts (pipeline_id, stage_id, owner_id, n, value)
SELECT pipeline_id, stage_id, owner_id, count(*), coalesce(sum(value), 0) FROM leads WHERE deleted_at IS NULL GROUP BY 1, 2, 3;
SELECT set_config('lume.lead_scope', '', true);
