-- Phase 5A: after a meeting with a lead ends, its owner is asked for the outcome once (a "Log outcome"
-- follow-up); recording the outcome completes it.
ALTER TABLE meetings
  ADD COLUMN outcome_asked_at timestamptz,
  ADD COLUMN outcome_task_id uuid REFERENCES tasks (id) ON DELETE SET NULL;
CREATE INDEX meetings_ended ON meetings (ends_at) WHERE status = 'scheduled' AND outcome_asked_at IS NULL;
