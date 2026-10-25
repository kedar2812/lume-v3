-- WhatsApp W2 (spec 2026-10-18 §5.1): LUME AI reads what each WhatsApp reply means, counted against the month as
-- every read is, at most once per reply.
ALTER TABLE ai_reads DROP CONSTRAINT ai_reads_task_check;
ALTER TABLE ai_reads ADD CONSTRAINT ai_reads_task_check
  CHECK (task IN ('next_step', 'catch_up', 'autopilot_first', 'autopilot_reply', 'reply_meaning'));
CREATE UNIQUE INDEX ai_reads_reply_once ON ai_reads (source_activity_id) WHERE task = 'reply_meaning';
