-- LUME AI's limits, held exactly (spec 2026-10-18 §2.2): a read reserves its slot in one short transaction under one
-- lock — so two reads at the last slot can't both pass — and the provider is called outside it; the slot is then
-- finished as ok or failed. A slot never finished (the API stopped mid-read) stops counting after two minutes.
ALTER TABLE ai_reads DROP CONSTRAINT ai_reads_status_check;
ALTER TABLE ai_reads ADD CONSTRAINT ai_reads_status_check CHECK (status IN ('pending', 'ok', 'failed'));

-- What counts against the limits at `p_now`: good reads, and slots reserved in the last two minutes.
CREATE FUNCTION lume_ai_counts(p_now timestamptz, hour_since timestamptz, week_since timestamptz)
RETURNS TABLE (hour_n integer, hour_oldest timestamptz, week_n integer)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT count(*) FILTER (WHERE r.created_at > hour_since)::integer,
         min(r.created_at) FILTER (WHERE r.created_at > hour_since),
         count(*) FILTER (WHERE r.created_at > week_since)::integer
  FROM ai_reads r
  WHERE r.created_at > least(hour_since, week_since)
    AND (r.status = 'ok' OR (r.status = 'pending' AND r.created_at > p_now - interval '2 minutes'));
$$;
REVOKE ALL ON FUNCTION lume_ai_counts(timestamptz, timestamptz, timestamptz) FROM PUBLIC;

-- The business's use (0068), now counting fresh reserved slots too; "now" is the hour window's end.
CREATE OR REPLACE FUNCTION lume_ai_usage(hour_since timestamptz, week_since timestamptz)
RETURNS TABLE (hour_n integer, hour_oldest timestamptz, week_n integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  was text := current_setting('lume.lead_scope', true);
BEGIN
  PERFORM set_config('lume.lead_scope', 'all', true);
  RETURN QUERY SELECT * FROM lume_ai_counts(hour_since + interval '1 hour', hour_since, week_since);
  PERFORM set_config('lume.lead_scope', coalesce(was, ''), true);
END;
$$;

-- Reserve a slot for a read on a lead the caller has already checked they may see. Refused ('hour' or 'week', the
-- week first) when a limit is reached, with the oldest read in the hour so the caller can say when it frees up.
CREATE FUNCTION lume_ai_reserve(
  p_lead uuid, p_user uuid, p_task text, p_source uuid, p_provider text, p_model text, p_now timestamptz,
  p_hour_limit integer, p_week_limit integer, p_hour_since timestamptz, p_week_since timestamptz)
RETURNS TABLE (id uuid, refused text, hour_oldest timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  was text := current_setting('lume.lead_scope', true);
  c record;
  new_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('lume.ai_reads'));
  PERFORM set_config('lume.lead_scope', 'all', true);
  SELECT * INTO c FROM lume_ai_counts(p_now, p_hour_since, p_week_since);
  IF p_week_limit IS NOT NULL AND c.week_n >= p_week_limit THEN
    PERFORM set_config('lume.lead_scope', coalesce(was, ''), true);
    RETURN QUERY SELECT NULL::uuid, 'week'::text, c.hour_oldest;
    RETURN;
  END IF;
  IF p_hour_limit IS NOT NULL AND c.hour_n >= p_hour_limit THEN
    PERFORM set_config('lume.lead_scope', coalesce(was, ''), true);
    RETURN QUERY SELECT NULL::uuid, 'hour'::text, c.hour_oldest;
    RETURN;
  END IF;
  INSERT INTO ai_reads (id, lead_id, user_id, task, source_activity_id, provider, model, status, created_at)
  VALUES (gen_random_uuid(), p_lead, p_user, p_task, p_source, p_provider, p_model, 'pending', p_now)
  RETURNING ai_reads.id INTO new_id;
  PERFORM set_config('lume.lead_scope', coalesce(was, ''), true);
  RETURN QUERY SELECT new_id, NULL::text, coalesce(c.hour_oldest, p_now);
END;
$$;

-- Finish a reserved slot, once: ok with its result and tokens, or failed (not counted).
CREATE FUNCTION lume_ai_finish(p_id uuid, p_status text, p_result jsonb, p_in integer, p_out integer)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  was text := current_setting('lume.lead_scope', true);
BEGIN
  IF p_status NOT IN ('ok', 'failed') THEN
    RAISE EXCEPTION 'lume_ai_finish: status must be ok or failed';
  END IF;
  PERFORM set_config('lume.lead_scope', 'all', true);
  UPDATE ai_reads SET status = p_status, result = p_result, input_tokens = p_in, output_tokens = p_out
  WHERE ai_reads.id = p_id AND status = 'pending';
  PERFORM set_config('lume.lead_scope', coalesce(was, ''), true);
END;
$$;

REVOKE ALL ON FUNCTION lume_ai_reserve(uuid, uuid, text, uuid, text, text, timestamptz, integer, integer, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION lume_ai_finish(uuid, text, jsonb, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_ai_reserve(uuid, uuid, text, uuid, text, text, timestamptz, integer, integer, timestamptz, timestamptz) TO lume_app;
GRANT EXECUTE ON FUNCTION lume_ai_finish(uuid, text, jsonb, integer, integer) TO lume_app;
