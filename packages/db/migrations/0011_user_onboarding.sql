-- Per-person preferences and the state of their first-run onboarding and product tour (spec §4.2).
ALTER TABLE users
  ADD COLUMN preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN onboarding  jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN tour        jsonb NOT NULL DEFAULT '{}'::jsonb;
