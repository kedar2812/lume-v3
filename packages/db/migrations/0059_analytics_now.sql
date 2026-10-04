-- Phase 8D gate (spec 2026-10-04-phase-8d-analytics-to-canvas-design §2.2): at a million leads the boards' "now"
-- numbers read every open lead per request (the funnel's average age, stuck leads and forecast by month; quality's
-- phone numbers). They are kept here instead, refreshed with the rollups every 10 minutes (lume_refresh_now), so a
-- board reads a few hundred rows. Counts a person acts on (leads in a stage, overdue follow-ups) stay live.

-- A person's own analytics read their own rollup rows by index, not every row through row-level security.
CREATE INDEX analytics_daily_cohort_user ON analytics_daily_cohort (user_id, day);
CREATE INDEX analytics_daily_event_user ON analytics_daily_event (user_id, day);
CREATE INDEX analytics_daily_stage_user ON analytics_daily_stage (user_id, day);
CREATE INDEX analytics_daily_slot_user ON analytics_daily_slot (user_id, day);
CREATE INDEX analytics_daily_reach_user ON analytics_daily_reach (user_id, day);
-- Leads nobody owns, by how long they've waited (quality).
CREATE INDEX leads_unowned ON leads (created_at) WHERE owner_id IS NULL AND deleted_at IS NULL;
-- Duplicates merged into an existing lead (each leaves "imported again" on it), by when (quality).
CREATE INDEX activities_imported_again ON activities (occurred_at) WHERE type = 'imported_again';

-- Open leads now, per pipeline, stage, owner and source: how many, worth what, the sum of when each entered its stage
-- (seconds since 1970: average age = now − sum ÷ n), and how many have sat past the stage's allowed time.
CREATE TABLE analytics_open_now (
  pipeline_id uuid    NOT NULL,
  stage_id    uuid    NOT NULL,
  owner_id    uuid,
  source_id   uuid,
  n           integer NOT NULL,
  value       numeric(20, 2) NOT NULL,
  entered_sum float8  NOT NULL,
  stuck       integer NOT NULL
);
-- The forecast by the month LUME expects each open lead to be won (8A spec §4.2), as value × the stage's chance.
CREATE TABLE analytics_forecast_now (
  pipeline_id uuid    NOT NULL,
  stage_id    uuid    NOT NULL,
  owner_id    uuid,
  source_id   uuid,
  month       text    NOT NULL,
  v           float8  NOT NULL
);
-- Phone numbers by what LUME can make of them, per owner, source and pipeline.
CREATE TABLE analytics_phone_now (
  pipeline_id  uuid    NOT NULL,
  owner_id     uuid,
  source_id    uuid,
  phone_status text    NOT NULL,
  n            integer NOT NULL
);
-- When they were last counted, for the screen's "counted … ago".
CREATE TABLE analytics_now_counted (
  id         smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  counted_at timestamptz NOT NULL
);

ALTER TABLE analytics_open_now ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_forecast_now ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_phone_now ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_now_counted ENABLE ROW LEVEL SECURITY;
-- Seen at the viewer's analytics reach, as the rollups are.
CREATE POLICY read ON analytics_open_now FOR SELECT USING (lume_sees_credit(owner_id));
CREATE POLICY read ON analytics_forecast_now FOR SELECT USING (lume_sees_credit(owner_id));
CREATE POLICY read ON analytics_phone_now FOR SELECT USING (lume_sees_credit(owner_id));
CREATE POLICY read ON analytics_now_counted FOR SELECT USING (true);
CREATE POLICY backup_read ON analytics_open_now FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON analytics_forecast_now FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON analytics_phone_now FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON analytics_now_counted FOR SELECT TO lume_readonly_backup USING (true);
GRANT SELECT ON analytics_open_now, analytics_forecast_now, analytics_phone_now, analytics_now_counted TO lume_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON analytics_open_now, analytics_forecast_now, analytics_phone_now,
  analytics_now_counted FROM lume_app;
REVOKE ALL ON analytics_open_now, analytics_forecast_now, analytics_phone_now, analytics_now_counted FROM lume_worker;

CREATE FUNCTION lume_refresh_now(tz text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('lume.analytics.now'));
  -- Every lead, as lume_rollup_day reads them; this transaction only.
  PERFORM set_config('lume.lead_scope', 'all', true);
  DELETE FROM analytics_open_now;
  DELETE FROM analytics_forecast_now;
  DELETE FROM analytics_phone_now;

  INSERT INTO analytics_open_now
  SELECT l.pipeline_id, l.stage_id, l.owner_id, l.source_id, count(*)::int, coalesce(sum(l.value), 0),
         sum(extract(epoch FROM l.stage_entered_at)),
         count(*) FILTER (WHERE s.sla_hours IS NOT NULL AND l.stage_entered_at < now() - make_interval(hours => s.sla_hours))::int
  FROM leads l JOIN stages s ON s.id = l.stage_id AND s.kind = 'open'
  WHERE l.deleted_at IS NULL
  GROUP BY 1, 2, 3, 4;

  -- Each open stage's median days from entering it to winning (wins of the last 180 days); with fewer than 10 such
  -- wins, the pipeline's median days to win less the median days spent before the stage. Never earlier than today.
  INSERT INTO analytics_forecast_now
  WITH wins AS (
    SELECT l.id, l.pipeline_id, l.created_at, l.won_at FROM leads l
    WHERE l.deleted_at IS NULL AND l.won_at >= now() - interval '180 days'
  ), entries AS (
    SELECT w.pipeline_id, h.to_stage_id AS stage_id, extract(epoch FROM w.won_at - h.changed_at) / 86400 AS to_win,
           extract(epoch FROM h.changed_at - w.created_at) / 86400 AS before
    FROM wins w JOIN lead_stage_history h ON h.lead_id = w.id AND h.changed_at <= w.won_at
  ), cycle AS (
    SELECT pipeline_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM won_at - created_at) / 86400) AS m
    FROM wins GROUP BY pipeline_id
  ), med AS (
    SELECT e.stage_id,
           CASE WHEN count(*) >= 10 THEN percentile_cont(0.5) WITHIN GROUP (ORDER BY e.to_win)
                ELSE greatest(0, max(c.m) - percentile_cont(0.5) WITHIN GROUP (ORDER BY e.before)) END AS days
    FROM entries e JOIN cycle c ON c.pipeline_id = e.pipeline_id GROUP BY e.stage_id
  )
  SELECT l.pipeline_id, l.stage_id, l.owner_id, l.source_id,
         to_char(greatest(l.stage_entered_at + make_interval(secs => coalesce(med.days, 0) * 86400), now()) AT TIME ZONE tz,
                 'YYYY-MM'),
         sum(l.value * coalesce(s.win_probability, 0) / 100)::float8
  FROM leads l JOIN stages s ON s.id = l.stage_id AND s.kind = 'open'
  LEFT JOIN med ON med.stage_id = l.stage_id
  WHERE l.deleted_at IS NULL AND l.value IS NOT NULL
  GROUP BY 1, 2, 3, 4, 5;

  INSERT INTO analytics_phone_now
  SELECT l.pipeline_id, l.owner_id, l.source_id, l.phone_status, count(*)::int
  FROM leads l WHERE l.deleted_at IS NULL GROUP BY 1, 2, 3, 4;

  INSERT INTO analytics_now_counted (id, counted_at) VALUES (1, now())
  ON CONFLICT (id) DO UPDATE SET counted_at = EXCLUDED.counted_at;
  PERFORM set_config('lume.lead_scope', '', true);
END
$$;
REVOKE ALL ON FUNCTION lume_refresh_now(text) FROM PUBLIC;
-- The API's rollup job runs it, on its own connection; nothing a request can reach calls it.
GRANT EXECUTE ON FUNCTION lume_refresh_now(text) TO lume_app;
