-- Phase 8D (spec 2026-10-04-phase-8d-analytics-to-canvas-design §4 Timing): no-shows by the call's start slot, for
-- the meetings board and the "calls at this time are missed more often" insight. A function beside lume_rollup_day
-- (which clears the day's slots first), run after it and before lume_rollup_slot_totals, so 0053's body stays as it is.
ALTER TABLE analytics_daily_slot DROP CONSTRAINT analytics_daily_slot_kind_check;
ALTER TABLE analytics_daily_slot ADD CONSTRAINT analytics_daily_slot_kind_check
  CHECK (kind IN ('arrivals', 'sends', 'replies', 'booked', 'held', 'no_show'));

CREATE FUNCTION lume_rollup_noshow_day(d date, tz text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
DECLARE
  t0 timestamptz := d::timestamp AT TIME ZONE tz;
  t1 timestamptz := (d + 1)::timestamp AT TIME ZONE tz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('lume.analytics.day'), d - DATE '2000-01-01');
  -- Every lead and meeting, as lume_rollup_day reads them; this transaction only.
  PERFORM set_config('lume.lead_scope', 'all', true), set_config('lume.calendar_sweep', 'on', true);
  DELETE FROM analytics_daily_slot WHERE day = d AND kind = 'no_show';
  INSERT INTO analytics_daily_slot
  SELECT d, 'no_show', extract(dow FROM m.starts_at AT TIME ZONE tz)::smallint,
         extract(hour FROM m.starts_at AT TIME ZONE tz)::smallint, m.owner_id, count(*)::int
  FROM meetings m JOIN leads l ON l.id = m.lead_id AND l.deleted_at IS NULL
  WHERE m.starts_at >= t0 AND m.starts_at < t1 AND m.status = 'no_show'
  GROUP BY 1, 2, 3, 4, 5;
  PERFORM set_config('lume.lead_scope', '', true), set_config('lume.calendar_sweep', '', true);
END
$$;
REVOKE ALL ON FUNCTION lume_rollup_noshow_day(date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_rollup_noshow_day(date, text) TO lume_app;
