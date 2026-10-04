-- Phase 7C (canvas Profile): each person's look — their initials on a colour they pick, or a photo they lined up.
-- users keeps only the colour and a version (so a select of users never carries image bytes); the photo itself, a
-- 256 px square WebP (JPEG where the browser can't make WebP) the browser cropped and the API checked, lives in
-- user_avatars.
ALTER TABLE users
  -- A palette key, or null for the colour LUME picks from the name.
  ADD COLUMN avatar_color   text    CHECK (avatar_color IN ('red', 'amber', 'blue', 'green', 'rose', 'teal')),
  -- Goes up with every change, so the photo's address changes and caches never show an old one. 0 = never set.
  ADD COLUMN avatar_version integer NOT NULL DEFAULT 0;

CREATE TABLE user_avatars (
  user_id    uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  image      bytea       NOT NULL CHECK (octet_length(image) <= 204800),
  type       text        NOT NULL CHECK (type IN ('image/webp', 'image/jpeg')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON user_avatars TO lume_app;
REVOKE ALL ON user_avatars FROM lume_worker;
