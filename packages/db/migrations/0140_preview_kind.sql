-- Team Chat photos' thumbnails (plan 2026-11-25-team-chat-2b Task 7): a preview made for bytes the library doesn't
-- hold (a photo sent in chat) carries the kind and type it was sent as, for the preview job, which reads neither
-- chat's rows (they're their readers' alone) nor guesses. The library's own previews keep reading theirs.
ALTER TABLE file_previews ADD COLUMN kind text, ADD COLUMN mime text;
