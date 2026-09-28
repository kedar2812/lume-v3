-- Phase 2C (spec 2026-09-28-phase-2c §3): a webhook is a lead source that is posted to. Every accepted
-- post is one event, kept encrypted until it's dealt with; refused posts are only counted.
ALTER TABLE lead_sources
  ADD COLUMN rejected integer NOT NULL DEFAULT 0,
  ADD COLUMN last_rejected_reason text,
  ADD COLUMN last_event_at timestamptz;

ALTER TABLE imports DROP CONSTRAINT imports_kind;
ALTER TABLE imports ADD CONSTRAINT imports_kind CHECK (kind IN ('csv', 'sheet', 'webhook'));

CREATE TABLE webhook_events (
  id bigserial PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES lead_sources (id) ON DELETE CASCADE,
  event_key text NOT NULL,
  payload_enc bytea,
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CONSTRAINT webhook_events_status CHECK (status IN ('test', 'queued', 'done', 'error', 'dismissed')),
  result text CONSTRAINT webhook_events_result CHECK (result IN ('created', 'merged', 'skipped')),
  lead_id uuid,
  problems jsonb NOT NULL DEFAULT '[]'::jsonb,
  processed_at timestamptz,
  -- When retention cleared the payload (as 2A's imports): the sweep needs no read of the payload itself.
  purged_at timestamptz,
  CONSTRAINT webhook_events_once UNIQUE (source_id, event_key)
);
CREATE INDEX webhook_events_recent ON webhook_events (source_id, received_at DESC);
CREATE INDEX webhook_events_problems ON webhook_events (source_id) WHERE status = 'error';

REVOKE ALL ON webhook_events FROM lume_worker;
REVOKE ALL ON SEQUENCE webhook_events_id_seq FROM lume_worker;
GRANT SELECT (id, status, processed_at, received_at, purged_at), UPDATE (payload_enc, purged_at), DELETE ON webhook_events TO lume_worker;
