-- Phase 8B (spec 2026-10-04-phase-8-analytics-design §5.3): the Monday email of last week's numbers, claimed once a
-- week per person before it's sent (as the daily digest claims its day), so two runs at once send it once.
CREATE TABLE weekly_runs (
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  week_start date        NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, week_start)
);
GRANT SELECT, INSERT, DELETE ON weekly_runs TO lume_app;
REVOKE ALL ON weekly_runs FROM lume_worker;
