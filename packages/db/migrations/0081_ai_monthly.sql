-- Autopilot A1 (spec 2026-10-19 §4; owner 2026-10-19: monthly, and generous): LUME AI counted by the calendar month on
-- the business's clock, beside the hour (and the week, for a LUME whose licence server doesn't sign the month yet).
-- The month also adds up its tokens, for the spend the ring shows at the owner's prices.
DROP FUNCTION lume_ai_reserve(uuid, uuid, text, uuid, text, text, timestamptz, integer, integer, timestamptz, timestamptz);
DROP FUNCTION lume_ai_usage(timestamptz, timestamptz);
DROP FUNCTION lume_ai_counts(timestamptz, timestamptz, timestamptz);

-- What counts against the limits at `p_now`: good reads, and slots reserved in the last two minutes.
CREATE FUNCTION lume_ai_counts(p_now timestamptz, hour_since timestamptz, week_since timestamptz, month_since timestamptz)
RETURNS TABLE (hour_n integer, hour_oldest timestamptz, week_n integer, month_n integer, month_in bigint, month_out bigint)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT count(*) FILTER (WHERE r.created_at > hour_since)::integer,
         min(r.created_at) FILTER (WHERE r.created_at > hour_since),
         count(*) FILTER (WHERE r.created_at > week_since)::integer,
         count(*) FILTER (WHERE r.created_at >= month_since)::integer,
         coalesce(sum(r.input_tokens) FILTER (WHERE r.created_at >= month_since), 0)::bigint,
         coalesce(sum(r.output_tokens) FILTER (WHERE r.created_at >= month_since), 0)::bigint
  FROM ai_reads r
  WHERE r.created_at >= least(hour_since, week_since, month_since)
    AND (r.status = 'ok' OR (r.status = 'pending' AND r.created_at > p_now - interval '2 minutes'));
$$;
REVOKE ALL ON FUNCTION lume_ai_counts(timestamptz, timestamptz, timestamptz, timestamptz) FROM PUBLIC;

CREATE FUNCTION lume_ai_usage(hour_since timestamptz, week_since timestamptz, month_since timestamptz)
RETURNS TABLE (hour_n integer, hour_oldest timestamptz, week_n integer, month_n integer, month_in bigint, month_out bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  was text := current_setting('lume.lead_scope', true);
BEGIN
  PERFORM set_config('lume.lead_scope', 'all', true);
  RETURN QUERY SELECT * FROM lume_ai_counts(hour_since + interval '1 hour', hour_since, week_since, month_since);
  PERFORM set_config('lume.lead_scope', coalesce(was, ''), true);
END;
$$;

-- Reserve a slot for a read on a lead the caller has already checked they may see. Refused ('month', then 'week', then
-- 'hour': the longest wait first) when a limit is reached, with the oldest read in the hour.
CREATE FUNCTION lume_ai_reserve(
  p_lead uuid, p_user uuid, p_task text, p_source uuid, p_provider text, p_model text, p_now timestamptz,
  p_hour_limit integer, p_week_limit integer, p_month_limit integer,
  p_hour_since timestamptz, p_week_since timestamptz, p_month_since timestamptz)
RETURNS TABLE (id uuid, refused text, hour_oldest timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  was text := current_setting('lume.lead_scope', true);
  c record;
  new_id uuid;
  why text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('lume.ai_reads'));
  PERFORM set_config('lume.lead_scope', 'all', true);
  SELECT * INTO c FROM lume_ai_counts(p_now, p_hour_since, p_week_since, p_month_since);
  why := CASE
    WHEN p_month_limit IS NOT NULL AND c.month_n >= p_month_limit THEN 'month'
    WHEN p_week_limit IS NOT NULL AND c.week_n >= p_week_limit THEN 'week'
    WHEN p_hour_limit IS NOT NULL AND c.hour_n >= p_hour_limit THEN 'hour'
  END;
  IF why IS NOT NULL THEN
    PERFORM set_config('lume.lead_scope', coalesce(was, ''), true);
    RETURN QUERY SELECT NULL::uuid, why, c.hour_oldest;
    RETURN;
  END IF;
  INSERT INTO ai_reads (id, lead_id, user_id, task, source_activity_id, provider, model, status, created_at)
  VALUES (gen_random_uuid(), p_lead, p_user, p_task, p_source, p_provider, p_model, 'pending', p_now)
  RETURNING ai_reads.id INTO new_id;
  PERFORM set_config('lume.lead_scope', coalesce(was, ''), true);
  RETURN QUERY SELECT new_id, NULL::text, coalesce(c.hour_oldest, p_now);
END;
$$;
REVOKE ALL ON FUNCTION lume_ai_usage(timestamptz, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_ai_usage(timestamptz, timestamptz, timestamptz) TO lume_app;
REVOKE ALL ON FUNCTION lume_ai_reserve(uuid, uuid, text, uuid, text, text, timestamptz, integer, integer, integer, timestamptz, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_ai_reserve(uuid, uuid, text, uuid, text, text, timestamptz, integer, integer, integer, timestamptz, timestamptz, timestamptz) TO lume_app;

-- The month's notices, once each per month; and a top-up asked for, once a month (shown to admins as asked).
ALTER TABLE ai_limit_notices DROP CONSTRAINT ai_limit_notices_kind_check;
ALTER TABLE ai_limit_notices ADD CONSTRAINT ai_limit_notices_kind_check CHECK (
  kind IN ('week_75', 'week_90', 'week_limit', 'hour_limit', 'month_75', 'month_90', 'month_limit', 'topup_asked'));
