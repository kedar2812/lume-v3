-- Bug hunt 2026-11-17: changing the business's time zone recomputed only the days the rollup job revisits on its own
-- (today, yesterday, the week nightly, 90 days weekly); older days stayed counted in the old zone for good, and their
-- tiles disagreed with drills and filtered reads, which use the new zone. Now every past day since the first lead is
-- marked, and the analytics job recomputes them within minutes (lume_claim_dirty_days), today and yesterday being its
-- 10-minute run's.
CREATE FUNCTION lume_mark_dirty_timezone() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
DECLARE
  was text := current_setting('lume.lead_scope', true);
  first date;
  recent date := (now() AT TIME ZONE NEW.timezone)::date - 1;
BEGIN
  IF NEW.timezone IS NOT DISTINCT FROM OLD.timezone THEN
    RETURN NULL;
  END IF;
  -- Every lead, as the rollup reads them; put back after, for the rest of this transaction.
  PERFORM set_config('lume.lead_scope', 'all', true);
  SELECT least(min(lead_created_at), min((created_at AT TIME ZONE NEW.timezone)::date)) INTO first FROM leads;
  PERFORM set_config('lume.lead_scope', coalesce(was, ''), true);
  IF first IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO analytics_dirty_days (day)
  SELECT d::date FROM generate_series(first - 1, recent - 1, interval '1 day') d
  ON CONFLICT (day) DO NOTHING;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION lume_mark_dirty_timezone() FROM PUBLIC;

CREATE TRIGGER settings_timezone_recount AFTER UPDATE OF timezone ON settings
  FOR EACH ROW EXECUTE FUNCTION lume_mark_dirty_timezone();
