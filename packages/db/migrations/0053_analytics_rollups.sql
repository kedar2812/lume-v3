-- Phase 8A (spec 2026-10-04-phase-8-analytics-design §5.1): analytics reads daily rollups, kept in the business's own
-- days, so any range at a million leads is a sum of small rows. Recomputing a day is idempotent: lume_rollup_day
-- deletes the day and writes it again from the live tables, under an advisory lock per day.
--
-- Credit, as the spec defines it:
-- - cohort numbers (arrived, contacted, replied, won so far, speed to lead) go to the owner at arrival, or the first
--   owner if the lead arrived unassigned;
-- - won and lost go to the owner at that moment; calls to the person who holds them; follow-ups to their assignee;
--   messages to who sent them.
-- Rows are read under the viewer's analytics reach (lume.analytics_scope, set per request from analytics.view),
-- which needn't match what leads they see. Unassigned credit (a null user) is seen with 'all' only.

CREATE FUNCTION lume_analytics_scope() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('lume.analytics_scope', true), '')
$$;
-- Schema-qualified, like lume_sees_owner (0048): pg_dump reads with an empty search_path.
CREATE FUNCTION lume_sees_credit(u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT public.lume_analytics_scope()) = 'all'
    OR (u IS NOT NULL AND (SELECT public.lume_user()) IS NOT NULL AND (
          u = (SELECT public.lume_user())
          OR ((SELECT public.lume_analytics_scope()) = 'team' AND u = ANY ((SELECT public.lume_team_members())::uuid[])))),
    false)
$$;

-- The owner a lead had at an instant: the last change at or before it; before any change, whoever it arrived with.
CREATE FUNCTION lume_owner_at(lead uuid, at timestamptz, current_owner uuid) RETURNS uuid
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN last.id IS NOT NULL THEN last.to_user_id
              WHEN first.id IS NOT NULL THEN first.from_user_id
              ELSE current_owner END
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (SELECT h.id, h.to_user_id FROM lead_assignment_history h
                     WHERE h.lead_id = lead AND h.changed_at <= at ORDER BY h.changed_at DESC, h.id DESC LIMIT 1) last ON true
  LEFT JOIN LATERAL (SELECT h.id, h.from_user_id FROM lead_assignment_history h
                     WHERE h.lead_id = lead ORDER BY h.changed_at, h.id LIMIT 1) first ON true
$$;
-- When a lead that arrived unassigned first got an owner (null if it arrived with one, or never got one).
CREATE FUNCTION lume_first_assigned(lead uuid) RETURNS timestamptz LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT h.changed_at FROM lead_assignment_history h
  WHERE h.lead_id = lead AND h.to_user_id IS NOT NULL ORDER BY h.changed_at, h.id LIMIT 1
$$;

CREATE TABLE analytics_daily_cohort (
  day                 date    NOT NULL,
  user_id             uuid,
  source_id           uuid,
  pipeline_id         uuid    NOT NULL,
  arrived             integer NOT NULL,
  contacted           integer NOT NULL,
  replied             integer NOT NULL,
  won                 integer NOT NULL,
  contact_minutes_sum bigint  NOT NULL,
  within_1h           integer NOT NULL,
  within_24h          integer NOT NULL,
  -- Speed to lead, in the twelve buckets of @lume/core's DURATION_EDGES (minutes).
  speed_hist          integer[] NOT NULL
);
CREATE UNIQUE INDEX analytics_daily_cohort_key ON analytics_daily_cohort
  (day, coalesce(user_id, '00000000-0000-0000-0000-000000000000'), coalesce(source_id, '00000000-0000-0000-0000-000000000000'), pipeline_id);

CREATE TABLE analytics_daily_event (
  day              date          NOT NULL,
  user_id          uuid,
  source_id        uuid,
  pipeline_id      uuid,
  won              integer       NOT NULL,
  won_value        numeric(16, 2) NOT NULL,
  won_no_value     integer       NOT NULL,
  lost             integer       NOT NULL,
  booked           integer       NOT NULL,
  held             integer       NOT NULL,
  no_show          integer       NOT NULL,
  cancelled        integer       NOT NULL,
  tasks_due        integer       NOT NULL,
  tasks_done       integer       NOT NULL,
  tasks_on_time    integer       NOT NULL,
  late_minutes_sum bigint        NOT NULL,
  late_count       integer       NOT NULL,
  sends            integer       NOT NULL,
  replies72        integer       NOT NULL
);
CREATE UNIQUE INDEX analytics_daily_event_key ON analytics_daily_event
  (day, coalesce(user_id, '00000000-0000-0000-0000-000000000000'), coalesce(source_id, '00000000-0000-0000-0000-000000000000'),
   coalesce(pipeline_id, '00000000-0000-0000-0000-000000000000'));

CREATE TABLE analytics_daily_stage (
  day              date      NOT NULL,
  pipeline_id      uuid      NOT NULL,
  stage_id         uuid      NOT NULL,
  user_id          uuid,
  entered          integer   NOT NULL,
  exited           integer   NOT NULL,
  stay_minutes_sum bigint    NOT NULL,
  stay_hist        integer[] NOT NULL
);
CREATE UNIQUE INDEX analytics_daily_stage_key ON analytics_daily_stage
  (day, pipeline_id, stage_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'));

-- The funnel (spec §4 `funnel`): each cohort lead's furthest stage, open stages in their order and then won (a lost
-- lead counts at the furthest stage it reached before it was lost). "Reached stage k or later" is a sum over these.
CREATE TABLE analytics_daily_reach (
  day         date    NOT NULL,
  user_id     uuid,
  source_id   uuid,
  pipeline_id uuid    NOT NULL,
  stage_id    uuid    NOT NULL,
  n           integer NOT NULL
);
CREATE UNIQUE INDEX analytics_daily_reach_key ON analytics_daily_reach
  (day, coalesce(user_id, '00000000-0000-0000-0000-000000000000'), coalesce(source_id, '00000000-0000-0000-0000-000000000000'),
   pipeline_id, stage_id);

CREATE TABLE analytics_daily_slot (
  day     date     NOT NULL,
  kind    text     NOT NULL CHECK (kind IN ('arrivals', 'sends', 'replies', 'booked', 'held')),
  -- 0 = Sunday … 6 = Saturday, and the hour, in the business's time.
  dow     smallint NOT NULL CHECK (dow BETWEEN 0 AND 6),
  hour    smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
  user_id uuid,
  n       integer  NOT NULL
);
CREATE UNIQUE INDEX analytics_daily_slot_key ON analytics_daily_slot
  (day, kind, dow, hour, coalesce(user_id, '00000000-0000-0000-0000-000000000000'));

-- What the day's recompute reads, by time.
CREATE INDEX leads_won_at ON leads (won_at) WHERE won_at IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX meetings_created ON meetings (created_at);
CREATE INDEX meetings_starts ON meetings (starts_at);
CREATE INDEX tasks_due ON tasks (due_at);
CREATE INDEX lead_stage_history_time ON lead_stage_history (changed_at);
CREATE INDEX activities_type_time ON activities (type, occurred_at) WHERE type IN ('whatsapp_confirmed_sent', 'reply_logged');

ALTER TABLE analytics_daily_cohort ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_daily_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_daily_stage ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_daily_slot ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_daily_reach ENABLE ROW LEVEL SECURITY;
CREATE POLICY read ON analytics_daily_cohort FOR SELECT USING (lume_sees_credit(user_id));
CREATE POLICY read ON analytics_daily_event FOR SELECT USING (lume_sees_credit(user_id));
CREATE POLICY read ON analytics_daily_stage FOR SELECT USING (lume_sees_credit(user_id));
CREATE POLICY read ON analytics_daily_slot FOR SELECT USING (lume_sees_credit(user_id));
CREATE POLICY read ON analytics_daily_reach FOR SELECT USING (lume_sees_credit(user_id));
CREATE POLICY backup_read ON analytics_daily_cohort FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON analytics_daily_event FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON analytics_daily_stage FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON analytics_daily_slot FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON analytics_daily_reach FOR SELECT TO lume_readonly_backup USING (true);
GRANT SELECT ON analytics_daily_cohort, analytics_daily_event, analytics_daily_stage, analytics_daily_slot, analytics_daily_reach TO lume_app;
-- Only lume_rollup_day writes them.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON analytics_daily_cohort, analytics_daily_event, analytics_daily_stage, analytics_daily_slot, analytics_daily_reach FROM lume_app;
REVOKE ALL ON analytics_daily_cohort, analytics_daily_event, analytics_daily_stage, analytics_daily_slot, analytics_daily_reach FROM lume_worker;

-- One business day, recomputed from the live tables. Safe to run again, and alongside another run of the same day.
CREATE FUNCTION lume_rollup_day(d date, tz text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
DECLARE
  t0 timestamptz := d::timestamp AT TIME ZONE tz;
  t1 timestamptz := (d + 1)::timestamp AT TIME ZONE tz;
  edges float8[] := ARRAY[5, 15, 30, 60, 120, 240, 480, 1440, 2880, 4320, 10080];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('lume.analytics.day'), d - DATE '2000-01-01');
  -- Every lead in reach, as the 0047/0048 backfills read them, and every meeting (the calendar sweep's reach);
  -- this transaction only. Run in its own transaction (the rollup job), never inside a person's request.
  PERFORM set_config('lume.lead_scope', 'all', true), set_config('lume.calendar_sweep', 'on', true);
  DELETE FROM analytics_daily_cohort WHERE day = d;
  DELETE FROM analytics_daily_event WHERE day = d;
  DELETE FROM analytics_daily_stage WHERE day = d;
  DELETE FROM analytics_daily_slot WHERE day = d;
  DELETE FROM analytics_daily_reach WHERE day = d;

  -- Cohort: the leads that arrived on d (their enquiry date if they carry one, else the day LUME received them).
  INSERT INTO analytics_daily_cohort
  SELECT d, c.user_id, c.source_id, c.pipeline_id, count(*),
         count(*) FILTER (WHERE c.contact_at IS NOT NULL),
         count(*) FILTER (WHERE c.contact_at IS NOT NULL AND c.reply_at IS NOT NULL),
         count(*) FILTER (WHERE c.won),
         coalesce(round(sum(c.mins)), 0)::bigint,
         count(*) FILTER (WHERE c.mins < 60),
         count(*) FILTER (WHERE c.mins < 1440),
         ARRAY[count(*) FILTER (WHERE c.b = 0), count(*) FILTER (WHERE c.b = 1), count(*) FILTER (WHERE c.b = 2),
               count(*) FILTER (WHERE c.b = 3), count(*) FILTER (WHERE c.b = 4), count(*) FILTER (WHERE c.b = 5),
               count(*) FILTER (WHERE c.b = 6), count(*) FILTER (WHERE c.b = 7), count(*) FILTER (WHERE c.b = 8),
               count(*) FILTER (WHERE c.b = 9), count(*) FILTER (WHERE c.b = 10), count(*) FILTER (WHERE c.b = 11)]::integer[]
  FROM (
    SELECT s.*, width_bucket(s.mins, edges) AS b
    FROM (
      SELECT l.source_id, l.pipeline_id, coalesce(o.at_arrival, o.first_owner) AS user_id,
             f.first_contact_at AS contact_at, f.first_reply_at AS reply_at, l.won_at IS NOT NULL AS won,
             CASE WHEN f.first_contact_at IS NULL THEN NULL
                  ELSE greatest(0, extract(epoch FROM f.first_contact_at -
                         CASE WHEN o.at_arrival IS NULL THEN coalesce(lume_first_assigned(l.id), l.created_at)
                              ELSE l.created_at END) / 60) END AS mins
      FROM leads l
      LEFT JOIN lead_firsts f ON f.lead_id = l.id
      CROSS JOIN LATERAL (
        SELECT lume_owner_at(l.id, l.created_at, l.owner_id) AS at_arrival,
               (SELECT h.to_user_id FROM lead_assignment_history h WHERE h.lead_id = l.id AND h.to_user_id IS NOT NULL
                ORDER BY h.changed_at, h.id LIMIT 1) AS first_owner
      ) o
      WHERE l.deleted_at IS NULL
        AND (l.lead_created_at = d OR (l.lead_created_at IS NULL AND l.created_at >= t0 AND l.created_at < t1))
    ) s
  ) c
  GROUP BY c.user_id, c.source_id, c.pipeline_id;

  -- How far each lead of the cohort got: its furthest stage among those it ever stood in (open stages by position,
  -- then won; lost never counts as progress).
  INSERT INTO analytics_daily_reach
  SELECT d, r.user_id, r.source_id, r.pipeline_id, r.stage_id, count(*)::int
  FROM (
    SELECT l.source_id, l.pipeline_id,
           coalesce(lume_owner_at(l.id, l.created_at, l.owner_id),
                    (SELECT h.to_user_id FROM lead_assignment_history h WHERE h.lead_id = l.id AND h.to_user_id IS NOT NULL
                     ORDER BY h.changed_at, h.id LIMIT 1)) AS user_id,
           (SELECT s.id FROM stages s
            WHERE s.pipeline_id = l.pipeline_id AND s.kind IN ('open', 'won')
              AND (s.id = l.stage_id OR EXISTS (SELECT 1 FROM lead_stage_history h WHERE h.lead_id = l.id
                                                AND (h.to_stage_id = s.id OR h.from_stage_id = s.id)))
            ORDER BY (s.kind = 'won') DESC, s.position DESC LIMIT 1) AS stage_id
    FROM leads l
    WHERE l.deleted_at IS NULL
      AND (l.lead_created_at = d OR (l.lead_created_at IS NULL AND l.created_at >= t0 AND l.created_at < t1))
  ) r
  WHERE r.stage_id IS NOT NULL
  GROUP BY r.user_id, r.source_id, r.pipeline_id, r.stage_id;

  -- Events on d.
  INSERT INTO analytics_daily_event
  SELECT d, e.user_id, e.source_id, e.pipeline_id,
         sum(e.won)::int, coalesce(sum(e.won_value), 0), sum(e.won_no_value)::int, sum(e.lost)::int,
         sum(e.booked)::int, sum(e.held)::int, sum(e.no_show)::int, sum(e.cancelled)::int,
         sum(e.tasks_due)::int, sum(e.tasks_done)::int, sum(e.tasks_on_time)::int,
         coalesce(round(sum(e.late_minutes)), 0)::bigint, sum(e.late_count)::int, sum(e.sends)::int, sum(e.replies72)::int
  FROM (
    SELECT lume_owner_at(l.id, l.won_at, l.owner_id) AS user_id, l.source_id, l.pipeline_id,
           1 AS won, l.value AS won_value, (l.value IS NULL)::int AS won_no_value, 0 AS lost, 0 AS booked, 0 AS held,
           0 AS no_show, 0 AS cancelled, 0 AS tasks_due, 0 AS tasks_done, 0 AS tasks_on_time, 0::numeric AS late_minutes,
           0 AS late_count, 0 AS sends, 0 AS replies72
    FROM leads l WHERE l.deleted_at IS NULL AND l.won_at >= t0 AND l.won_at < t1
    UNION ALL
    SELECT lume_owner_at(l.id, l.lost_at, l.owner_id), l.source_id, l.pipeline_id,
           0, NULL, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    FROM leads l WHERE l.deleted_at IS NULL AND l.lost_at >= t0 AND l.lost_at < t1
    UNION ALL
    -- A booking is counted on the day it was made; a meeting moved to a new time isn't booked again.
    SELECT m.owner_id, l.source_id, l.pipeline_id, 0, NULL, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    FROM meetings m JOIN leads l ON l.id = m.lead_id AND l.deleted_at IS NULL
    WHERE m.created_at >= t0 AND m.created_at < t1 AND m.status <> 'rescheduled'
    UNION ALL
    SELECT m.owner_id, l.source_id, l.pipeline_id, 0, NULL, 0, 0, 0,
           (m.status = 'completed')::int, (m.status = 'no_show')::int, (m.status = 'cancelled')::int, 0, 0, 0, 0, 0, 0, 0
    FROM meetings m JOIN leads l ON l.id = m.lead_id AND l.deleted_at IS NULL
    WHERE m.starts_at >= t0 AND m.starts_at < t1 AND m.status IN ('completed', 'no_show', 'cancelled')
    UNION ALL
    -- Follow-ups due on d: on time when done by their time, with five minutes' grace.
    SELECT t.assignee_id, l.source_id, l.pipeline_id, 0, NULL, 0, 0, 0, 0, 0, 0, 1,
           (t.status = 'done')::int,
           (t.status = 'done' AND t.done_at <= t.due_at + interval '5 minutes')::int,
           CASE WHEN t.status = 'done' AND t.done_at > t.due_at + interval '5 minutes'
                THEN extract(epoch FROM t.done_at - t.due_at) / 60 ELSE 0 END,
           (t.status = 'done' AND t.done_at > t.due_at + interval '5 minutes')::int, 0, 0
    FROM tasks t JOIN leads l ON l.id = t.lead_id AND l.deleted_at IS NULL
    WHERE t.due_at >= t0 AND t.due_at < t1
    UNION ALL
    -- Messages confirmed sent on d, and whether the lead replied within 72 hours.
    SELECT a.user_id, l.source_id, l.pipeline_id, 0, NULL, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
           EXISTS (SELECT 1 FROM activities r WHERE r.lead_id = a.lead_id AND r.type = 'reply_logged'
                   AND r.occurred_at > a.occurred_at AND r.occurred_at <= a.occurred_at + interval '72 hours')::int
    FROM activities a JOIN leads l ON l.id = a.lead_id AND l.deleted_at IS NULL
    WHERE a.type = 'whatsapp_confirmed_sent' AND a.occurred_at >= t0 AND a.occurred_at < t1
  ) e
  GROUP BY e.user_id, e.source_id, e.pipeline_id;

  -- Stages on d: entries, and stays that ended (how long a lead sat in the stage it left).
  INSERT INTO analytics_daily_stage
  SELECT d, x.pipeline_id, x.stage_id, x.user_id, sum(x.entered)::int, sum(x.exited)::int,
         coalesce(round(sum(x.mins)), 0)::bigint,
         ARRAY[count(*) FILTER (WHERE x.b = 0), count(*) FILTER (WHERE x.b = 1), count(*) FILTER (WHERE x.b = 2),
               count(*) FILTER (WHERE x.b = 3), count(*) FILTER (WHERE x.b = 4), count(*) FILTER (WHERE x.b = 5),
               count(*) FILTER (WHERE x.b = 6), count(*) FILTER (WHERE x.b = 7), count(*) FILTER (WHERE x.b = 8),
               count(*) FILTER (WHERE x.b = 9), count(*) FILTER (WHERE x.b = 10), count(*) FILTER (WHERE x.b = 11)]::integer[]
  FROM (
    SELECT h.pipeline_id, h.to_stage_id AS stage_id, lume_owner_at(l.id, h.changed_at, l.owner_id) AS user_id,
           1 AS entered, 0 AS exited, NULL::float8 AS mins, NULL::int AS b
    FROM lead_stage_history h JOIN leads l ON l.id = h.lead_id AND l.deleted_at IS NULL
    WHERE h.changed_at >= t0 AND h.changed_at < t1
    UNION ALL
    SELECT h.pipeline_id, h.from_stage_id, lume_owner_at(l.id, h.changed_at, l.owner_id), 0, 1, s.mins,
           width_bucket(s.mins, edges)
    FROM lead_stage_history h JOIN leads l ON l.id = h.lead_id AND l.deleted_at IS NULL
    CROSS JOIN LATERAL (
      SELECT greatest(0, extract(epoch FROM h.changed_at - coalesce(
               (SELECT p.changed_at FROM lead_stage_history p WHERE p.lead_id = h.lead_id AND p.changed_at < h.changed_at
                ORDER BY p.changed_at DESC, p.id DESC LIMIT 1), l.created_at)) / 60) AS mins
    ) s
    WHERE h.changed_at >= t0 AND h.changed_at < t1 AND h.from_stage_id IS NOT NULL
  ) x
  GROUP BY x.pipeline_id, x.stage_id, x.user_id;

  -- When things happen, by weekday and hour in the business's time.
  INSERT INTO analytics_daily_slot
  SELECT d, z.kind, extract(dow FROM z.at AT TIME ZONE tz)::smallint, extract(hour FROM z.at AT TIME ZONE tz)::smallint,
         z.user_id, count(*)::int
  FROM (
    SELECT 'arrivals' AS kind, l.created_at AS at, lume_owner_at(l.id, l.created_at, l.owner_id) AS user_id
    FROM leads l WHERE l.deleted_at IS NULL AND l.created_at >= t0 AND l.created_at < t1
    UNION ALL
    SELECT 'sends', a.occurred_at, a.user_id
    FROM activities a JOIN leads l ON l.id = a.lead_id AND l.deleted_at IS NULL
    WHERE a.type = 'whatsapp_confirmed_sent' AND a.occurred_at >= t0 AND a.occurred_at < t1
    UNION ALL
    SELECT 'replies', a.occurred_at, a.user_id
    FROM activities a JOIN leads l ON l.id = a.lead_id AND l.deleted_at IS NULL
    WHERE a.type = 'whatsapp_confirmed_sent' AND a.occurred_at >= t0 AND a.occurred_at < t1
      AND EXISTS (SELECT 1 FROM activities r WHERE r.lead_id = a.lead_id AND r.type = 'reply_logged'
                  AND r.occurred_at > a.occurred_at AND r.occurred_at <= a.occurred_at + interval '72 hours')
    UNION ALL
    SELECT 'booked', m.starts_at, m.owner_id
    FROM meetings m JOIN leads l ON l.id = m.lead_id AND l.deleted_at IS NULL
    WHERE m.starts_at >= t0 AND m.starts_at < t1 AND m.status IN ('scheduled', 'completed', 'no_show')
    UNION ALL
    SELECT 'held', m.starts_at, m.owner_id
    FROM meetings m JOIN leads l ON l.id = m.lead_id AND l.deleted_at IS NULL
    WHERE m.starts_at >= t0 AND m.starts_at < t1 AND m.status = 'completed'
  ) z
  GROUP BY 1, 2, 3, 4, 5;

  PERFORM set_config('lume.lead_scope', '', true), set_config('lume.calendar_sweep', '', true);
END
$$;
REVOKE ALL ON FUNCTION lume_rollup_day(date, text) FROM PUBLIC;
-- The API's rollup job runs it, on its own connection; nothing a request can reach calls it.
GRANT EXECUTE ON FUNCTION lume_rollup_day(date, text) TO lume_app;
