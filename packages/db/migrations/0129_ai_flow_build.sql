-- LUME AI builds a flow (plan 2026-11-23-flow-builder, Task C1): like a template draft, a read about the business and
-- no lead. Counted and costed like every read (lume_ai_reserve); the read with no lead may now be either.
ALTER TABLE ai_reads DROP CONSTRAINT ai_reads_task_check;
ALTER TABLE ai_reads ADD CONSTRAINT ai_reads_task_check
  CHECK (task IN ('next_step', 'catch_up', 'autopilot_first', 'autopilot_reply', 'reply_meaning', 'template_draft',
                  'flow_build'));
ALTER TABLE ai_reads DROP CONSTRAINT ai_reads_lead_or_template;
ALTER TABLE ai_reads ADD CONSTRAINT ai_reads_lead_or_template
  CHECK (lead_id IS NOT NULL OR task IN ('template_draft', 'flow_build'));
-- Row security is forced, so the definer functions need the same case in every rule (0097).
DROP POLICY ai_reads_read ON ai_reads;
DROP POLICY ai_reads_create ON ai_reads;
DROP POLICY ai_reads_outcome ON ai_reads;
CREATE POLICY ai_reads_read ON ai_reads FOR SELECT
  USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id)
         OR (lead_id IS NULL AND task IN ('template_draft', 'flow_build')));
CREATE POLICY ai_reads_create ON ai_reads FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id)
              OR (lead_id IS NULL AND task IN ('template_draft', 'flow_build')));
CREATE POLICY ai_reads_outcome ON ai_reads FOR UPDATE
  USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id)
         OR (lead_id IS NULL AND task IN ('template_draft', 'flow_build')))
  WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id)
              OR (lead_id IS NULL AND task IN ('template_draft', 'flow_build')));
