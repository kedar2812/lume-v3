-- What's new in LUME (spec docs/superpowers/specs/2026-11-02-whats-new-design.md): per person, the last version whose
-- window they saw, the stories they used ("<version>:<story>") and the Today pill they put away. Kept on the server so
-- seen on one device is seen on every one.
ALTER TABLE users
  ADD COLUMN whats_new jsonb NOT NULL DEFAULT '{}'::jsonb;
