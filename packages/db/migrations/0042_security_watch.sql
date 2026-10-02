-- Phase 6A (plan 2026-10-02-phase-6a-watch): the watch. A person can be paused (suspended) by a rule, each breach
-- is an alert for the admins, and the rules count the audit rows the watched acts already write (plan ruling R1).

-- Suspended: sessions ended, sign-in refused until an admin restores them. Their leads stay theirs.
ALTER TABLE users DROP CONSTRAINT users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('invited', 'active', 'disabled', 'suspended'));
-- Set on restore: acts before it aren't counted again, so the burst that paused someone can't pause them twice.
ALTER TABLE users ADD COLUMN watch_from timestamptz;

CREATE TABLE security_alerts (
  id           uuid        PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES users (id),
  rule         text        NOT NULL CHECK (rule IN ('reveals', 'leadsOpened', 'queueRuns')),
  observed     integer     NOT NULL CHECK (observed >= 0),
  threshold    integer     NOT NULL CHECK (threshold >= 0),
  window_start timestamptz NOT NULL,
  window_end   timestamptz NOT NULL,
  -- What LUME did: told the admins, or told them and paused the person.
  action       text        NOT NULL CHECK (action IN ('alerted', 'suspended')),
  status       text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution   text        CHECK (resolution IN ('restored', 'kept_suspended', 'offboarded', 'dismissed')),
  resolved_by  uuid        REFERENCES users (id),
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT security_alerts_resolved CHECK ((status = 'open') = (resolution IS NULL))
);
CREATE INDEX security_alerts_status ON security_alerts (status, created_at DESC);
CREATE INDEX security_alerts_person ON security_alerts (user_id, rule, created_at DESC);
GRANT SELECT, INSERT, UPDATE ON security_alerts TO lume_app;

-- Every rule counts one person's rows of one act over a window: the reveal, the lead opened, the queue run.
CREATE INDEX audit_log_watch ON audit_log (actor_user_id, action, at DESC)
  WHERE action IN ('lead.contact.reveal', 'lead.view', 'queue.started');
