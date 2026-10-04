-- Phase 8A (spec 2026-10-04-phase-8-analytics-design §3): what each source costs a month, the goals a business
-- sets, and which suggestions each person has already been shown (so LUME doesn't repeat itself).

-- In the business's one currency; spread over a range by its days.
ALTER TABLE lead_sources ADD COLUMN monthly_spend numeric(14, 2) CHECK (monthly_spend >= 0);

CREATE TABLE goals (
  id           uuid          PRIMARY KEY,
  scope        text          NOT NULL CHECK (scope IN ('user', 'team', 'business')),
  -- The person or team the goal is for; null for the whole business.
  scope_id     uuid,
  metric       text          NOT NULL CHECK (metric IN ('won', 'revenue', 'calls_held', 'new_leads', 'ontime')),
  period       text          NOT NULL CHECK (period IN ('month', 'quarter')),
  period_start date          NOT NULL,
  target       numeric(14, 2) NOT NULL CHECK (target > 0),
  created_by   uuid          REFERENCES users (id),
  created_at   timestamptz   NOT NULL DEFAULT now(),
  updated_at   timestamptz   NOT NULL DEFAULT now(),
  CHECK ((scope = 'business') = (scope_id IS NULL))
);
CREATE UNIQUE INDEX goals_one ON goals (scope, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'), metric, period, period_start);

-- A suggestion (detector + subject) shown to a person, and how big it was then (cooldown: spec §6.4).
CREATE TABLE analytics_insight_seen (
  user_id   uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  detector  text        NOT NULL,
  subject   text        NOT NULL,
  magnitude numeric     NOT NULL,
  shown_at  timestamptz NOT NULL,
  PRIMARY KEY (user_id, detector, subject)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON goals, analytics_insight_seen TO lume_app;
-- The weekly email reads goals through the app's queue; the worker role has no business with either.
REVOKE ALL ON goals, analytics_insight_seen FROM lume_worker;
