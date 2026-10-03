-- Phase 7A (Task 5): the stage strip's counts, kept by LUME instead of counted on every load. At 1,000,000 leads a
-- live count took 386 ms (everyone's) and 363 ms (a team lead's), and grows with the leads. Here each (pipeline,
-- stage, owner) holds its live leads and their value, changed by every statement that changes leads, so the counts
-- (unfiltered, or filtered by owner or stage) are a handful of rows. Any other filter still counts live.
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

-- Read as leads are: everyone's counts for 'all' (unassigned included), your own, your team's. LUME (the owner)
-- writes it from the triggers below; the app may only read it. Not FORCEd: the triggers write as the owner.
ALTER TABLE lead_counts ENABLE ROW LEVEL SECURITY;
CREATE POLICY lead_counts_read ON lead_counts FOR SELECT USING (
  coalesce(
    (SELECT lume_scope()) = 'all'
    OR (owner_id IS NOT NULL AND (SELECT lume_user()) IS NOT NULL AND (
          owner_id = (SELECT lume_user())
          OR ((SELECT lume_scope()) = 'team' AND owner_id = ANY ((SELECT lume_team_members())::uuid[])))),
    false)
);
CREATE POLICY backup_read ON lead_counts FOR SELECT TO lume_readonly_backup USING (true);
REVOKE ALL ON lead_counts FROM lume_app, lume_worker;
GRANT SELECT ON lead_counts TO lume_app;

-- One statement's change to leads, as net changes per (pipeline, stage, owner): live leads in minus live leads out.
-- Applied in key order, so two writers never take the same rows in opposite orders; a conflicting insert adds to the
-- latest row, so concurrent changes all count.
CREATE FUNCTION lead_counts_after_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO lead_counts AS c (pipeline_id, stage_id, owner_id, n, value)
  SELECT pipeline_id, stage_id, owner_id, count(*), coalesce(sum(value), 0)
    FROM new_rows WHERE deleted_at IS NULL GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
  ON CONFLICT (pipeline_id, stage_id, owner_id) DO UPDATE SET n = c.n + EXCLUDED.n, value = c.value + EXCLUDED.value;
  RETURN NULL;
END $$;

CREATE FUNCTION lead_counts_after_update() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO lead_counts AS c (pipeline_id, stage_id, owner_id, n, value)
  SELECT pipeline_id, stage_id, owner_id, sum(dn), sum(dv) FROM (
    SELECT pipeline_id, stage_id, owner_id, 1 AS dn, coalesce(value, 0) AS dv FROM new_rows WHERE deleted_at IS NULL
    UNION ALL
    SELECT pipeline_id, stage_id, owner_id, -1, -coalesce(value, 0) FROM old_rows WHERE deleted_at IS NULL
  ) d
  GROUP BY 1, 2, 3 HAVING sum(dn) <> 0 OR sum(dv) <> 0 ORDER BY 1, 2, 3
  ON CONFLICT (pipeline_id, stage_id, owner_id) DO UPDATE SET n = c.n + EXCLUDED.n, value = c.value + EXCLUDED.value;
  RETURN NULL;
END $$;

CREATE FUNCTION lead_counts_after_delete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO lead_counts AS c (pipeline_id, stage_id, owner_id, n, value)
  SELECT pipeline_id, stage_id, owner_id, -count(*), -coalesce(sum(value), 0)
    FROM old_rows WHERE deleted_at IS NULL GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
  ON CONFLICT (pipeline_id, stage_id, owner_id) DO UPDATE SET n = c.n + EXCLUDED.n, value = c.value + EXCLUDED.value;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION lead_counts_after_insert(), lead_counts_after_update(), lead_counts_after_delete() FROM PUBLIC;
CREATE TRIGGER lead_counts_insert AFTER INSERT ON leads REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION lead_counts_after_insert();
CREATE TRIGGER lead_counts_update AFTER UPDATE ON leads REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION lead_counts_after_update();
CREATE TRIGGER lead_counts_delete AFTER DELETE ON leads REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION lead_counts_after_delete();

-- The backfill: every live lead, as the table owner with every lead in scope.
SELECT set_config('lume.lead_scope', 'all', true);
INSERT INTO lead_counts (pipeline_id, stage_id, owner_id, n, value)
SELECT pipeline_id, stage_id, owner_id, count(*), coalesce(sum(value), 0) FROM leads WHERE deleted_at IS NULL GROUP BY 1, 2, 3;
SELECT set_config('lume.lead_scope', '', true);
