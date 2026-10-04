-- Phase 8A scale gate: the timing heatmaps for someone who sees everyone read one row per hour a day, not one per
-- person per hour (24 against ~1,200 at a million leads). Kept from analytics_daily_slot by lume_rollup_slot_totals,
-- run beside lume_rollup_day; seen only with an analytics reach of 'all'.
CREATE TABLE analytics_daily_slot_total (
  day  date     NOT NULL,
  kind text     NOT NULL,
  dow  smallint NOT NULL,
  hour smallint NOT NULL,
  n    integer  NOT NULL,
  PRIMARY KEY (day, kind, dow, hour)
);
ALTER TABLE analytics_daily_slot_total ENABLE ROW LEVEL SECURITY;
CREATE POLICY read ON analytics_daily_slot_total FOR SELECT USING ((SELECT lume_analytics_scope()) = 'all');
CREATE POLICY backup_read ON analytics_daily_slot_total FOR SELECT TO lume_readonly_backup USING (true);
GRANT SELECT ON analytics_daily_slot_total TO lume_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON analytics_daily_slot_total FROM lume_app;
REVOKE ALL ON analytics_daily_slot_total FROM lume_worker;

CREATE FUNCTION lume_rollup_slot_totals(d date) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('lume.analytics.day'), d - DATE '2000-01-01');
  DELETE FROM analytics_daily_slot_total WHERE day = d;
  INSERT INTO analytics_daily_slot_total
  SELECT day, kind, dow, hour, sum(n)::int FROM analytics_daily_slot WHERE day = d GROUP BY 1, 2, 3, 4;
END
$$;
REVOKE ALL ON FUNCTION lume_rollup_slot_totals(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_rollup_slot_totals(date) TO lume_app;
