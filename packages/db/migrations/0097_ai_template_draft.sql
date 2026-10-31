-- LUME AI writes templates (2026-10-31): a read about the business, not a lead. Only that task may have no lead; every
-- other read still belongs to one. Counted against the month like every read (lume_ai_reserve, SECURITY DEFINER).
ALTER TABLE ai_reads ALTER COLUMN lead_id DROP NOT NULL;
ALTER TABLE ai_reads DROP CONSTRAINT ai_reads_task_check;
ALTER TABLE ai_reads ADD CONSTRAINT ai_reads_task_check
  CHECK (task IN ('next_step', 'catch_up', 'autopilot_first', 'autopilot_reply', 'reply_meaning', 'template_draft'));
ALTER TABLE ai_reads ADD CONSTRAINT ai_reads_lead_or_template
  CHECK (lead_id IS NOT NULL OR task = 'template_draft');
-- Row security is forced, so it holds inside the definer functions too (reserve, finish, the month's count): a draft's
-- read, with no lead, must pass each rule or it could neither be kept nor counted against the month. Exactly that
-- case is added; every other read still needs a lead.
DROP POLICY ai_reads_read ON ai_reads;
DROP POLICY ai_reads_create ON ai_reads;
DROP POLICY ai_reads_outcome ON ai_reads;
CREATE POLICY ai_reads_read ON ai_reads FOR SELECT
  USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id) OR (lead_id IS NULL AND task = 'template_draft'));
CREATE POLICY ai_reads_create ON ai_reads FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id) OR (lead_id IS NULL AND task = 'template_draft'));
CREATE POLICY ai_reads_outcome ON ai_reads FOR UPDATE
  USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id) OR (lead_id IS NULL AND task = 'template_draft'))
  WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id) OR (lead_id IS NULL AND task = 'template_draft'));
