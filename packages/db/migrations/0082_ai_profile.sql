-- Settings → LUME AI (Autopilot spec 2026-10-19 §5): what LUME AI knows about the business, its voice and the business's
-- standing choices, one validated document per business (packages/core/src/ai/profile.ts). Business configuration:
-- written only through Settings (settings.manage); the worker only reads it (Autopilot's run engine, A2).
CREATE TABLE ai_profile (
  id         smallint    PRIMARY KEY CHECK (id = 1),
  profile    jsonb       NOT NULL CHECK (jsonb_typeof(profile) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid        REFERENCES users (id)
);
REVOKE INSERT, UPDATE, DELETE ON ai_profile FROM lume_worker;
