-- From LUME's team (spec 2026-10-16 fleet §4): who pressed Got it on an announcement, so it shows once per person
-- on every device. Only the count per announcement ever leaves this server, with the check-in.
CREATE TABLE announcement_got_it (
  user_id         uuid        NOT NULL REFERENCES users ON DELETE CASCADE,
  announcement_id uuid        NOT NULL,
  at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, announcement_id)
);
CREATE INDEX announcement_got_it_by_announcement ON announcement_got_it (announcement_id);
