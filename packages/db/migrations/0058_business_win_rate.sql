-- Phase 8D (spec 2026-10-04-phase-8d-analytics-to-canvas-design §4, the rep's view): the business's leads and wins
-- for a range of days, so a rep can see their win rate beside the business's. Two numbers that name nobody; the
-- rollups' own row-level security would show a rep only their own rows, hence SECURITY DEFINER.
CREATE FUNCTION lume_business_win_rate(d0 date, d1 date) RETURNS TABLE (arrived int, won int)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(c.arrived), 0)::int, coalesce(sum(c.won), 0)::int
  FROM analytics_daily_cohort c WHERE c.day BETWEEN d0 AND d1
$$;
REVOKE ALL ON FUNCTION lume_business_win_rate(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_business_win_rate(date, date) TO lume_app;
