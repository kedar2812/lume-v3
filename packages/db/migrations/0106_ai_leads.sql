-- AI leads (owner's spec 2026-11-12): LUME AI's allowance counts leads a calendar month on the business's clock, not
-- reads. A lead counts once a month, the first time Autopilot starts on it or it gets an Autopilot reply, a suggested
-- next step or a catch-up; choosing a template, reading a reply's meaning and drafting a template never count. A lead
-- may have 20 counted reads a month. The hour and the month's reads (lume_ai_counts, unchanged) stay as a safety net.

-- One row per lead counted in a month ("YYYY-MM" on the business's clock). No foreign key: a lead deleted later still
-- used its place this month. Reached only through the definer functions below (no lead data: an id and a month).
CREATE TABLE ai_lead_months (
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  lead_id uuid NOT NULL,
  counted_at timestamptz NOT NULL,
  -- Started by Autopilot (its first message): counted whatever its reads do.
  autopilot boolean NOT NULL DEFAULT false,
  -- When it reached its 20 counted reads and was handed to a person (once a month).
  capped_at timestamptz,
  PRIMARY KEY (month, lead_id)
);
REVOKE ALL ON ai_lead_months FROM lume_app, lume_worker;

-- The month a counted read counts in; null for a read that never counts (and for reads from before AI leads).
ALTER TABLE ai_reads ADD COLUMN lead_month text CHECK (lead_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
CREATE INDEX ai_reads_lead_month ON ai_reads (lead_id, lead_month) WHERE lead_month IS NOT NULL;

-- A lead's counted reads in a month: good ones, and slots still being read (a stale one, older than two minutes,
-- counts no more, as in lume_ai_counts).
CREATE FUNCTION lume_ai_lead_reads(p_lead uuid, p_month text, p_now timestamptz)
RETURNS integer
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::integer FROM ai_reads r
   WHERE r.lead_id = p_lead AND r.lead_month = p_month
     AND (r.status = 'ok' OR (r.status = 'pending' AND r.created_at > p_now - interval '2 minutes'));
$$;
REVOKE ALL ON FUNCTION lume_ai_lead_reads(uuid, text, timestamptz) FROM PUBLIC;

DROP FUNCTION lume_ai_reserve(uuid, uuid, text, uuid, text, text, timestamptz, integer, integer, integer, timestamptz, timestamptz, timestamptz);

-- Reserve a slot for a read on a lead the caller has already checked they may see. `p_lead_month` is set only for a
-- read that counts: then a lead not yet counted this month is counted now (refused 'leads' when the month's AI leads
-- are used up), and a counted one is refused 'lead_cap' at its 20 reads. Refused first by the month's reads ('month'),
-- then the lead's, then the week, then the hour (the longest wait first), all under one lock.
CREATE FUNCTION lume_ai_reserve(
  p_lead uuid, p_user uuid, p_task text, p_source uuid, p_provider text, p_model text, p_now timestamptz,
  p_hour_limit integer, p_week_limit integer, p_month_limit integer,
  p_hour_since timestamptz, p_week_since timestamptz, p_month_since timestamptz,
  p_lead_month text, p_leads_limit integer, p_lead_max integer)
RETURNS TABLE (id uuid, refused text, hour_oldest timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  was text := current_setting('lume.lead_scope', true);
  c record;
  new_id uuid;
  why text;
  counted boolean := false;
BEGIN
  IF p_lead_month IS NOT NULL AND p_lead IS NULL THEN
    RAISE EXCEPTION 'lume_ai_reserve: a read that counts is about a lead';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('lume.ai_reads'));
  PERFORM set_config('lume.lead_scope', 'all', true);
  SELECT * INTO c FROM lume_ai_counts(p_now, p_hour_since, p_week_since, p_month_since);
  IF p_month_limit IS NOT NULL AND c.month_n >= p_month_limit THEN
    why := 'month';
  END IF;
  IF why IS NULL AND p_lead_month IS NOT NULL THEN
    counted := EXISTS (SELECT 1 FROM ai_lead_months m WHERE m.month = p_lead_month AND m.lead_id = p_lead);
    IF counted THEN
      IF p_lead_max IS NOT NULL AND lume_ai_lead_reads(p_lead, p_lead_month, p_now) >= p_lead_max THEN
        why := 'lead_cap';
      END IF;
    ELSIF p_leads_limit IS NOT NULL
      AND (SELECT count(*) FROM ai_lead_months m WHERE m.month = p_lead_month) >= p_leads_limit THEN
      why := 'leads';
    END IF;
  END IF;
  IF why IS NULL THEN
    why := CASE
      WHEN p_week_limit IS NOT NULL AND c.week_n >= p_week_limit THEN 'week'
      WHEN p_hour_limit IS NOT NULL AND c.hour_n >= p_hour_limit THEN 'hour'
    END;
  END IF;
  IF why IS NOT NULL THEN
    PERFORM set_config('lume.lead_scope', coalesce(was, ''), true);
    RETURN QUERY SELECT NULL::uuid, why, c.hour_oldest;
    RETURN;
  END IF;
  IF p_lead_month IS NOT NULL AND NOT counted THEN
    INSERT INTO ai_lead_months (month, lead_id, counted_at) VALUES (p_lead_month, p_lead, p_now);
  END IF;
  INSERT INTO ai_reads (id, lead_id, user_id, task, source_activity_id, provider, model, status, created_at, lead_month)
  VALUES (gen_random_uuid(), p_lead, p_user, p_task, p_source, p_provider, p_model, 'pending', p_now, p_lead_month)
  RETURNING ai_reads.id INTO new_id;
  PERFORM set_config('lume.lead_scope', coalesce(was, ''), true);
  RETURN QUERY SELECT new_id, NULL::text, coalesce(c.hour_oldest, p_now);
END;
$$;
REVOKE ALL ON FUNCTION lume_ai_reserve(uuid, uuid, text, uuid, text, text, timestamptz, integer, integer, integer, timestamptz, timestamptz, timestamptz, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_ai_reserve(uuid, uuid, text, uuid, text, text, timestamptz, integer, integer, integer, timestamptz, timestamptz, timestamptz, text, integer, integer) TO lume_app;

DROP FUNCTION lume_ai_finish(uuid, text, jsonb, integer, integer, integer, integer);

-- Finish a reserved slot, once: ok with its result, or failed (not counted); either way with the tokens the provider
-- billed (0 when it never answered). A failed read that counted its lead in uncounts it again, unless Autopilot
-- started on the lead or another of its counted reads is good or still being read: a lead LUME AI never managed to
-- do anything for doesn't use up the month.
CREATE FUNCTION lume_ai_finish(
  p_id uuid, p_status text, p_result jsonb, p_in integer, p_out integer, p_cache_write integer, p_cache_read integer)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  was text := current_setting('lume.lead_scope', true);
  r record;
BEGIN
  IF p_status NOT IN ('ok', 'failed') THEN
    RAISE EXCEPTION 'lume_ai_finish: status must be ok or failed';
  END IF;
  PERFORM set_config('lume.lead_scope', 'all', true);
  UPDATE ai_reads
     SET status = p_status, result = p_result, input_tokens = p_in, output_tokens = p_out,
         cache_write_tokens = p_cache_write, cache_read_tokens = p_cache_read
   WHERE ai_reads.id = p_id AND status = 'pending'
  RETURNING ai_reads.lead_id, ai_reads.lead_month INTO r;
  IF FOUND AND p_status = 'failed' AND r.lead_month IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('lume.ai_reads'));
    DELETE FROM ai_lead_months m
     WHERE m.month = r.lead_month AND m.lead_id = r.lead_id AND NOT m.autopilot
       AND NOT EXISTS (
         SELECT 1 FROM ai_reads o
          WHERE o.lead_id = r.lead_id AND o.lead_month = r.lead_month AND o.status IN ('ok', 'pending'));
  END IF;
  PERFORM set_config('lume.lead_scope', coalesce(was, ''), true);
END;
$$;
REVOKE ALL ON FUNCTION lume_ai_finish(uuid, text, jsonb, integer, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_ai_finish(uuid, text, jsonb, integer, integer, integer, integer) TO lume_app;

-- Autopilot starting on a lead (its first message) counts it, whether or not choosing the template needed a read:
-- 'counted' when it already was this month, 'started' when it is now, 'full' when the month's AI leads are used up.
CREATE FUNCTION lume_ai_start_lead(p_lead uuid, p_month text, p_now timestamptz, p_leads_limit integer)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('lume.ai_reads'));
  UPDATE ai_lead_months SET autopilot = true WHERE month = p_month AND lead_id = p_lead;
  IF FOUND THEN
    RETURN 'counted';
  END IF;
  IF p_leads_limit IS NOT NULL AND (SELECT count(*) FROM ai_lead_months m WHERE m.month = p_month) >= p_leads_limit THEN
    RETURN 'full';
  END IF;
  INSERT INTO ai_lead_months (month, lead_id, counted_at, autopilot) VALUES (p_month, p_lead, p_now, true);
  RETURN 'started';
END;
$$;
REVOKE ALL ON FUNCTION lume_ai_start_lead(uuid, text, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_ai_start_lead(uuid, text, timestamptz, integer) TO lume_app;

-- The month's AI leads (a number only).
CREATE FUNCTION lume_ai_leads_used(p_month text)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::integer FROM ai_lead_months WHERE month = p_month;
$$;
REVOKE ALL ON FUNCTION lume_ai_leads_used(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_ai_leads_used(text) TO lume_app;

-- Where a lead stands this month, for a caller who has already checked they may see it: whether it's counted, its
-- counted reads, and whether it was already handed to a person at its limit.
CREATE FUNCTION lume_ai_lead_month(p_lead uuid, p_month text, p_now timestamptz)
RETURNS TABLE (counted boolean, reads integer, capped boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  was text := current_setting('lume.lead_scope', true);
  n integer;
BEGIN
  PERFORM set_config('lume.lead_scope', 'all', true);
  n := lume_ai_lead_reads(p_lead, p_month, p_now);
  PERFORM set_config('lume.lead_scope', coalesce(was, ''), true);
  RETURN QUERY
    SELECT (m.lead_id IS NOT NULL), n, (m.capped_at IS NOT NULL)
      FROM (SELECT 1) one LEFT JOIN ai_lead_months m ON m.month = p_month AND m.lead_id = p_lead;
END;
$$;
REVOKE ALL ON FUNCTION lume_ai_lead_month(uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_ai_lead_month(uuid, text, timestamptz) TO lume_app;

-- Mark a counted lead handed to a person at its limit: true only the first time this month (it's told once).
CREATE FUNCTION lume_ai_lead_capped(p_lead uuid, p_month text, p_now timestamptz)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE ai_lead_months SET capped_at = p_now WHERE month = p_month AND lead_id = p_lead AND capped_at IS NULL;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION lume_ai_lead_capped(uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_ai_lead_capped(uuid, text, timestamptz) TO lume_app;

-- The AI leads notices, once per allowance as the month's are (a top-up raises it and they're heard again); Base's
-- allowance is 0.
ALTER TABLE ai_limit_notices DROP CONSTRAINT ai_limit_notices_kind_check;
ALTER TABLE ai_limit_notices ADD CONSTRAINT ai_limit_notices_kind_check CHECK (
  kind IN ('week_75', 'week_90', 'week_limit', 'hour_limit', 'month_75', 'month_90', 'month_limit', 'topup_asked',
           'leads_80', 'leads_limit'));
ALTER TABLE ai_limit_notices DROP CONSTRAINT ai_limit_notices_allowance_check;
ALTER TABLE ai_limit_notices ADD CONSTRAINT ai_limit_notices_allowance_check CHECK (allowance IS NULL OR allowance >= 0);

-- Nobody's month starts again: this month's leads (on the business's clock) are counted from what LUME AI already did
-- for them, its counted reads and Autopilot's first messages, and those reads count against their leads.
DO $$
DECLARE
  tz text := coalesce((SELECT timezone FROM settings WHERE id = 1), 'UTC');
  this_month text;
  since timestamptz;
  until timestamptz;
BEGIN
  PERFORM set_config('lume.lead_scope', 'all', true);
  this_month := to_char(now() AT TIME ZONE tz, 'YYYY-MM');
  since := date_trunc('month', now() AT TIME ZONE tz) AT TIME ZONE tz;
  until := (date_trunc('month', now() AT TIME ZONE tz) + interval '1 month') AT TIME ZONE tz;
  UPDATE ai_reads SET lead_month = this_month
   WHERE created_at >= since AND created_at < until AND lead_month IS NULL AND lead_id IS NOT NULL
     AND status IN ('ok', 'pending') AND task IN ('autopilot_reply', 'next_step', 'catch_up');
  INSERT INTO ai_lead_months (month, lead_id, counted_at)
    SELECT this_month, r.lead_id, min(r.created_at) FROM ai_reads r
     WHERE r.lead_month = this_month AND r.status = 'ok'
     GROUP BY r.lead_id
  ON CONFLICT DO NOTHING;
  INSERT INTO ai_lead_months (month, lead_id, counted_at, autopilot)
    SELECT this_month, l.lead_id, min(l.first_sent_at), true FROM autopilot_leads l
     WHERE l.first_sent_at >= since AND l.first_sent_at < until
     GROUP BY l.lead_id
  ON CONFLICT (month, lead_id) DO UPDATE SET autopilot = true;
  PERFORM set_config('lume.lead_scope', '', true);
END;
$$;
