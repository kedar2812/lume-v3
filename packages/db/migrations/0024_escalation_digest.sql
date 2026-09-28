-- Phase 3B (plan 2026-09-28-phase-3b): a follow-up left overdue reaches its managers once (escalated_at),
-- and each person gets one digest a local day (digest_runs). Escalation is on, after 24 hours, by default.
ALTER TABLE tasks ADD COLUMN escalated_at timestamptz;

CREATE TABLE digest_runs (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  local_date date NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  items int NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, local_date)
);
-- It holds no names, only that a digest went out: no row-level security, and nothing for the worker.
REVOKE ALL ON digest_runs FROM lume_worker;

ALTER TABLE settings
  ADD COLUMN follow_ups jsonb NOT NULL DEFAULT '{"escalation":{"enabled":true,"hours":24}}'::jsonb;
