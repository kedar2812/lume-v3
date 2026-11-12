-- What each LUME AI read cost (2026-11-12). A provider bills an answer LUME couldn't use (a refusal, cut short, not the
-- shape asked for), so a failed read keeps its tokens; and with prompt caching, the cache's writes and reads are billed
-- at their own prices, so they're kept apart from the input. The read allowance still counts good reads only
-- (lume_ai_counts, unchanged); the month's spend adds up every finished read, by the model that served it.
ALTER TABLE ai_reads ADD COLUMN cache_write_tokens integer NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0);
ALTER TABLE ai_reads ADD COLUMN cache_read_tokens integer NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0);

DROP FUNCTION lume_ai_finish(uuid, text, jsonb, integer, integer);

-- Finish a reserved slot, once: ok with its result, or failed (not counted against the limits); either way with the
-- tokens the provider billed (0 when it never answered).
CREATE FUNCTION lume_ai_finish(
  p_id uuid, p_status text, p_result jsonb, p_in integer, p_out integer, p_cache_write integer, p_cache_read integer)
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
  UPDATE ai_reads
     SET status = p_status, result = p_result, input_tokens = p_in, output_tokens = p_out,
         cache_write_tokens = p_cache_write, cache_read_tokens = p_cache_read
   WHERE ai_reads.id = p_id AND status = 'pending';
  PERFORM set_config('lume.lead_scope', coalesce(was, ''), true);
END;
$$;
REVOKE ALL ON FUNCTION lume_ai_finish(uuid, text, jsonb, integer, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_ai_finish(uuid, text, jsonb, integer, integer, integer, integer) TO lume_app;

-- The month's tokens by model, for the spend at each model's prices: every finished read, good or failed, whoever
-- asked and on whichever lead (numbers only, like lume_ai_usage). A pending read has no tokens yet.
CREATE FUNCTION lume_ai_month_tokens(month_since timestamptz)
RETURNS TABLE (model text, input_tokens bigint, output_tokens bigint, cache_write_tokens bigint, cache_read_tokens bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  was text := current_setting('lume.lead_scope', true);
BEGIN
  PERFORM set_config('lume.lead_scope', 'all', true);
  RETURN QUERY
    SELECT r.model,
           coalesce(sum(r.input_tokens), 0)::bigint,
           coalesce(sum(r.output_tokens), 0)::bigint,
           coalesce(sum(r.cache_write_tokens), 0)::bigint,
           coalesce(sum(r.cache_read_tokens), 0)::bigint
      FROM ai_reads r
     WHERE r.created_at >= month_since AND r.status IN ('ok', 'failed')
     GROUP BY r.model
     ORDER BY r.model;
  PERFORM set_config('lume.lead_scope', coalesce(was, ''), true);
END;
$$;
REVOKE ALL ON FUNCTION lume_ai_month_tokens(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_ai_month_tokens(timestamptz) TO lume_app;

-- The month's spend reads failed reads too: an index for them beside the good ones' (ai_reads_created).
CREATE INDEX ai_reads_failed_created ON ai_reads (created_at) WHERE status = 'failed';
