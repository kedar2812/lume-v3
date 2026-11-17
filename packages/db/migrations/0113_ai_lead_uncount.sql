-- Bug hunt 2026-11-17: Autopilot counts a lead in the month's AI leads as it starts on it, before its first message
-- is chosen; when choosing failed (three unusable answers) or the lead changed meanwhile, nothing was sent, yet the
-- lead stayed counted. This takes it back out, under the same lock as counting, only while LUME AI has done nothing
-- for the lead this month: no good or pending read of it.
CREATE FUNCTION lume_ai_unstart_lead(p_lead uuid, p_month text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  was text := current_setting('lume.lead_scope', true);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('lume.ai_reads'));
  PERFORM set_config('lume.lead_scope', 'all', true);
  DELETE FROM ai_lead_months m
   WHERE m.month = p_month AND m.lead_id = p_lead AND m.autopilot
     AND NOT EXISTS (
       SELECT 1 FROM ai_reads o
        WHERE o.lead_id = p_lead AND o.lead_month = p_month AND o.status IN ('ok', 'pending'));
  PERFORM set_config('lume.lead_scope', coalesce(was, ''), true);
END;
$$;
REVOKE ALL ON FUNCTION lume_ai_unstart_lead(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_ai_unstart_lead(uuid, text) TO lume_app;
