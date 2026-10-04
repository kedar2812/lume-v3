-- Owner, 2026-10-05: 12,000 leads imported with their own enquiry dates (June 2024 onwards) never reached the
-- analytics for those days. The rollups recompute today and yesterday every 10 minutes, the last 7 days nightly and
-- 90 days weekly; anything older was never counted again. Now every write that changes a past day's numbers (an
-- import, a Sheets sync, a webhook, a deletion, a backdated win or loss) marks that day, and the analytics job
-- recomputes marked days within minutes (lume_claim_dirty_days).

CREATE TABLE analytics_dirty_days (
  day       date        PRIMARY KEY,
  marked_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE analytics_dirty_days ENABLE ROW LEVEL SECURITY;
CREATE POLICY backup_read ON analytics_dirty_days FOR SELECT TO lume_readonly_backup USING (true);
REVOKE ALL ON analytics_dirty_days FROM lume_app, lume_worker;

-- The business days a lead's numbers sit on: its arrival (enquiry date, else when it came in), its win and its loss,
-- in the business's time. Today and yesterday are left out: the 10-minute run covers them.
CREATE FUNCTION lume_lead_days(enquiry date, created timestamptz, won timestamptz, lost timestamptz, tz text)
RETURNS SETOF date LANGUAGE sql IMMUTABLE AS $$
  SELECT d FROM (VALUES
    (coalesce(enquiry, (created AT TIME ZONE tz)::date)),
    ((won AT TIME ZONE tz)::date),
    ((lost AT TIME ZONE tz)::date)
  ) v(d)
  WHERE d IS NOT NULL
$$;

CREATE FUNCTION lume_mark_dirty_leads() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
DECLARE
  tz text := coalesce((SELECT timezone FROM settings WHERE id = 1), 'UTC');
  recent date := (now() AT TIME ZONE tz)::date - 1;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO analytics_dirty_days (day)
    SELECT DISTINCT d FROM new_rows n,
      LATERAL lume_lead_days(n.lead_created_at, n.created_at, n.won_at, n.lost_at, tz) d
    WHERE d < recent
    ON CONFLICT (day) DO NOTHING;
  ELSE
    -- Only rows whose day-defining columns, or what those days count, changed; both their old and new days.
    INSERT INTO analytics_dirty_days (day)
    SELECT DISTINCT d FROM old_rows o JOIN new_rows n ON n.id = o.id,
      LATERAL (
        SELECT lume_lead_days(o.lead_created_at, o.created_at, o.won_at, o.lost_at, tz)
        UNION
        SELECT lume_lead_days(n.lead_created_at, n.created_at, n.won_at, n.lost_at, tz)
      ) x(d)
    WHERE d < recent
      AND (o.lead_created_at IS DISTINCT FROM n.lead_created_at OR o.created_at IS DISTINCT FROM n.created_at
        OR o.won_at IS DISTINCT FROM n.won_at OR o.lost_at IS DISTINCT FROM n.lost_at
        OR o.deleted_at IS DISTINCT FROM n.deleted_at OR o.source_id IS DISTINCT FROM n.source_id
        OR o.pipeline_id IS DISTINCT FROM n.pipeline_id OR o.value IS DISTINCT FROM n.value
        OR o.product_id IS DISTINCT FROM n.product_id)
    ON CONFLICT (day) DO NOTHING;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION lume_mark_dirty_leads() FROM PUBLIC;

CREATE TRIGGER leads_mark_dirty_insert AFTER INSERT ON leads
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION lume_mark_dirty_leads();
CREATE TRIGGER leads_mark_dirty_update AFTER UPDATE ON leads
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION lume_mark_dirty_leads();

-- The analytics job takes up to `n` marked days, newest first, and recomputes them.
CREATE FUNCTION lume_claim_dirty_days(n int) RETURNS SETOF date LANGUAGE sql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
  DELETE FROM analytics_dirty_days
  WHERE day IN (SELECT day FROM analytics_dirty_days ORDER BY day DESC LIMIT n FOR UPDATE SKIP LOCKED)
  RETURNING day
$$;
REVOKE ALL ON FUNCTION lume_claim_dirty_days(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_claim_dirty_days(int) TO lume_app;
