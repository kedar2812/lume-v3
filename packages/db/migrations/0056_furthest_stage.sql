-- Phase 8D (spec 2026-10-04-phase-8d-analytics-to-canvas-design §4): the furthest stage a lead reached in a
-- pipeline (open stages by position, then won), from every stage it moved into or out of or stands in now, exactly
-- as analytics_daily_reach (0053) decides it. A lost lead counts where it got to before it was lost (lost is never
-- progress). For the live reads: a tag or field filter, and a funnel stage's drill-down.
CREATE FUNCTION lume_furthest_stage(lead uuid, pipeline uuid) RETURNS uuid
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT s.id FROM stages s
  WHERE s.pipeline_id = pipeline AND s.kind IN ('open', 'won')
    AND (s.id = (SELECT l.stage_id FROM leads l WHERE l.id = lead)
         OR EXISTS (SELECT 1 FROM lead_stage_history h WHERE h.lead_id = lead
                    AND (h.to_stage_id = s.id OR h.from_stage_id = s.id)))
  ORDER BY (s.kind = 'won') DESC, s.position DESC LIMIT 1
$$;
GRANT EXECUTE ON FUNCTION lume_furthest_stage(uuid, uuid) TO lume_app;
