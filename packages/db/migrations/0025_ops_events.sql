-- Phase 3C (plan 2026-09-28-phase-3c): what LUME's own jobs did or failed to do, for System health —
-- a digest that couldn't be sent, a no-touch run, an alert already given to admins today. Append-only;
-- never a lead's name or contact (kinds and ids only). The worker keeps 30 days.
CREATE TABLE ops_events (
  id     bigserial   PRIMARY KEY,
  kind   text        NOT NULL CHECK (kind ~ '^[a-z_.]{2,40}$'),
  ok     boolean     NOT NULL,
  detail jsonb       NOT NULL DEFAULT '{}'::jsonb,
  at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ops_events_kind_at ON ops_events (kind, at DESC);
REVOKE UPDATE, DELETE ON ops_events FROM lume_app;
REVOKE INSERT, UPDATE ON ops_events FROM lume_worker;
