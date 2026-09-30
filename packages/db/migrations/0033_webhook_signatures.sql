-- A signed webhook post's signature works once (2C final review, minor): a captured post sent again
-- within its five minutes, under a fresh event id, is a duplicate. Kept 10 minutes, then swept.
CREATE TABLE webhook_signatures (
  source_id uuid NOT NULL REFERENCES lead_sources ON DELETE CASCADE,
  signature_hash bytea NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, signature_hash)
);
CREATE INDEX webhook_signatures_seen ON webhook_signatures (seen_at);
REVOKE ALL ON webhook_signatures FROM lume_worker;
