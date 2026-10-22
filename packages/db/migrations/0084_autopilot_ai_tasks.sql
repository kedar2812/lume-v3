-- Autopilot A2 (spec 2026-10-19 §1–§3): LUME AI's reads in a run, choosing a first message's template and writing a
-- reply, counted against the month as every read is.
ALTER TABLE ai_reads DROP CONSTRAINT ai_reads_task_check;
ALTER TABLE ai_reads ADD CONSTRAINT ai_reads_task_check
  CHECK (task IN ('next_step', 'catch_up', 'autopilot_first', 'autopilot_reply'));
