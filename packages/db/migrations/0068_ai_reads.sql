-- LUME AI (spec 2026-10-18 §2.3): one row per read — which task, on which lead, by whom, with which model, how many
-- tokens, whether it worked, the cleaned result, and what the person did with it. No text from the lead's record
-- beyond the structured result.
CREATE TABLE ai_reads (
  id uuid PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES leads (id),
  user_id uuid NOT NULL REFERENCES users (id),
  task text NOT NULL CHECK (task IN ('next_step', 'catch_up')),
  source_activity_id uuid,
  provider text NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  status text NOT NULL CHECK (status IN ('ok', 'failed')),
  result jsonb,
  outcome text CHECK (outcome IN ('applied', 'dismissed')),
  outcome_by uuid REFERENCES users (id),
  outcome_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome IS NULL) = (outcome_at IS NULL) AND (outcome IS NULL) = (outcome_by IS NULL))
);
CREATE INDEX ai_reads_created ON ai_reads (created_at) WHERE status = 'ok';
CREATE INDEX ai_reads_lead ON ai_reads (lead_id, created_at DESC);

-- Seen with its lead, like the lead's activities.
ALTER TABLE ai_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_reads_read ON ai_reads FOR SELECT USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));
CREATE POLICY ai_reads_create ON ai_reads FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));
CREATE POLICY ai_reads_outcome ON ai_reads FOR UPDATE
  USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id))
  WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));
CREATE POLICY backup_read ON ai_reads FOR SELECT TO lume_readonly_backup USING (true);

-- The app writes a read and, later, only its outcome; it never deletes one. The worker has no use for them.
REVOKE UPDATE, DELETE ON ai_reads FROM lume_app;
GRANT UPDATE (outcome, outcome_by, outcome_at) ON ai_reads TO lume_app;
REVOKE ALL ON ai_reads FROM lume_worker;

-- The business's use for its hourly and weekly limits (§2.2): every good read, whoever asks — numbers only. The lead
-- scope is widened for this one query and put back as it was before returning, so a rep's count includes leads they
-- can't see while nothing else in their request does.
CREATE FUNCTION lume_ai_usage(hour_since timestamptz, week_since timestamptz)
RETURNS TABLE (hour_n integer, hour_oldest timestamptz, week_n integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  was text := current_setting('lume.lead_scope', true);
BEGIN
  PERFORM set_config('lume.lead_scope', 'all', true);
  RETURN QUERY
    SELECT count(*) FILTER (WHERE r.created_at > hour_since)::integer,
           min(r.created_at) FILTER (WHERE r.created_at > hour_since),
           count(*) FILTER (WHERE r.created_at > week_since)::integer
    FROM ai_reads r
    WHERE r.status = 'ok' AND r.created_at > least(hour_since, week_since);
  PERFORM set_config('lume.lead_scope', coalesce(was, ''), true);
END;
$$;
REVOKE ALL ON FUNCTION lume_ai_usage(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_ai_usage(timestamptz, timestamptz) TO lume_app;

-- Each limit notice to admins goes once per window (§2.2): "75% of this week", "90% of this week", "this hour's
-- limit reached". Bookkeeping only, no lead data.
CREATE TABLE ai_limit_notices (
  kind text NOT NULL CHECK (kind IN ('week_75', 'week_90', 'week_limit', 'hour_limit')),
  window_start timestamptz NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, window_start)
);
REVOKE ALL ON ai_limit_notices FROM lume_worker;
