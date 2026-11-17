-- Review 2026-11-17 (night): snoozing one follow-up of a repeating series moved its due time, and the next one was
-- worked out from that, so every later one kept the snooze ("every Monday 10:00", snoozed an hour once: Mondays at
-- 11:00 for good). The series' own time is kept here while a follow-up is snoozed; null means its due time is it.
ALTER TABLE tasks ADD COLUMN series_due_at timestamptz;
