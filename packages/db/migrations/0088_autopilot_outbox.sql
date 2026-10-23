-- Autopilot A2, the engine: a message LUME AI queued carries its run, and is cancelled, never sent, when the run was
-- paused or ended (or the lead taken over) before the send job reached it (spec 2026-10-19 §2.1: nothing after Pause).
ALTER TABLE whatsapp_outbox ADD COLUMN autopilot_run_id uuid REFERENCES autopilot_runs (id) ON DELETE SET NULL;
ALTER TABLE whatsapp_outbox DROP CONSTRAINT whatsapp_outbox_status_check;
ALTER TABLE whatsapp_outbox ADD CONSTRAINT whatsapp_outbox_status_check
  CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'cancelled'));

-- A run also pauses at the month's paid WhatsApp messages (W3b-2's limit), until an admin raises it.
ALTER TABLE autopilot_runs DROP CONSTRAINT autopilot_runs_pause_reason_check;
ALTER TABLE autopilot_runs ADD CONSTRAINT autopilot_runs_pause_reason_check
  CHECK (pause_reason IN ('person', 'month', 'quality', 'speaker', 'number', 'paid'));
