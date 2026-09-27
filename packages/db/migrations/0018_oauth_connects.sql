-- Phase 2B-2 (spec 2B §6): a "Connect with Google" in progress. The nonce is single-use and bound to the
-- person who started it; the grant (the sealed refresh token) waits here until a sheet is made from it.
CREATE TABLE oauth_connects (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  nonce_hash text NOT NULL CONSTRAINT oauth_connects_nonce UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  grant_enc bytea,
  file_id text,
  file_name text
);
REVOKE ALL ON oauth_connects FROM lume_worker;
GRANT SELECT (id, created_at), DELETE ON oauth_connects TO lume_worker;
