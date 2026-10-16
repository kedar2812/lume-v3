-- Feedback from a client's LUME (spec 2026-10-16 §2.2): what a team member told LUME's makers, and where the owner has
-- got to with it. Screenshots are kept apart, and removed 90 days after a report is closed; the words stay.
CREATE TABLE feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients ON DELETE CASCADE,
  received_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('bug', 'idea', 'confusing')),
  text text NOT NULL CHECK (length(btrim(text)) BETWEEN 1 AND 4000),
  reporter_name text NOT NULL CHECK (length(reporter_name) <= 120),
  reporter_email text NOT NULL CHECK (length(reporter_email) <= 254),
  reporter_role text NOT NULL CHECK (length(reporter_role) <= 60),
  page text NOT NULL CHECK (length(page) <= 300),
  app_version text NOT NULL CHECK (length(app_version) <= 40),
  browser text NOT NULL CHECK (length(browser) <= 300),
  screen text NOT NULL CHECK (length(screen) <= 40),
  theme text NOT NULL CHECK (theme IN ('porcelain', 'obsidian')),
  -- How many screenshots came with it: still said once they are removed.
  image_count smallint NOT NULL DEFAULT 0 CHECK (image_count BETWEEN 0 AND 5),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'seen', 'fixing', 'fixed', 'not_a_bug')),
  fixed_in text CHECK (fixed_in IS NULL OR fixed_in ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  closed_at timestamptz,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  images_removed_at timestamptz,
  CHECK ((status = 'fixed') = (fixed_in IS NOT NULL)),
  CHECK ((status IN ('fixed', 'not_a_bug')) = (closed_at IS NOT NULL))
);
CREATE INDEX feedback_received ON feedback (received_at DESC, id DESC);
CREATE INDEX feedback_client ON feedback (client_id, received_at DESC);
CREATE INDEX feedback_open ON feedback (status) WHERE status IN ('new', 'seen', 'fixing');
CREATE INDEX feedback_fixed_in ON feedback (fixed_in) WHERE fixed_in IS NOT NULL;

CREATE TABLE feedback_images (
  feedback_id uuid NOT NULL REFERENCES feedback ON DELETE CASCADE,
  n smallint NOT NULL CHECK (n BETWEEN 0 AND 4),
  type text NOT NULL CHECK (type IN ('image/webp', 'image/jpeg')),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 2400),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 2400),
  bytes bytea NOT NULL CHECK (length(bytes) BETWEEN 1 AND 1572864),
  PRIMARY KEY (feedback_id, n)
);
