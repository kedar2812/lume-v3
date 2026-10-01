-- 5C final review: a meeting reminder (a stage's "remind the lead before their meeting") knows its meeting,
-- so it closes when that meeting is cancelled, moved or gone. No foreign key: it's closed by id, after the fact.
ALTER TABLE tasks ADD COLUMN meeting_id uuid;
CREATE INDEX tasks_meeting ON tasks (meeting_id) WHERE meeting_id IS NOT NULL AND status = 'open';
