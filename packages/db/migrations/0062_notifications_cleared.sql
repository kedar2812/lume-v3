-- Owner, 2026-10-05: "Clear read" in the notification centre. Read notifications are hidden from the list at once
-- (and can be brought back with Undo); the worker's sweep removes read notifications later, as it always has.
ALTER TABLE notifications ADD COLUMN cleared_at timestamptz;
