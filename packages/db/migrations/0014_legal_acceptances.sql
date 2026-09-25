-- Before using LUME for the first time, everyone agrees to the licence agreement, terms of service
-- and privacy policy (owner, 2026-09-25). users.agreed_version drives the prompt; every acceptance is
-- kept as evidence: who, which version, when, and from which address and browser.
ALTER TABLE users ADD COLUMN agreed_version text;

CREATE TABLE legal_acceptances (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip text,
  user_agent text
);
CREATE INDEX legal_acceptances_user ON legal_acceptances (user_id, accepted_at DESC);
-- Evidence is appended, never rewritten.
REVOKE UPDATE, DELETE ON legal_acceptances FROM lume_app, lume_worker;
