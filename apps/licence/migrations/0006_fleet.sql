-- Fleet (spec 2026-10-16 fleet §2.1): what each LUME says about its own health with a check-in (counts, sizes,
-- times and fixed problem keys only), what it can show, and announcements from LUME's team to chosen clients.
ALTER TABLE check_ins ADD COLUMN health jsonb;
ALTER TABLE check_ins ADD COLUMN accepts text[];

CREATE TABLE announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 80),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 600),
  kind text NOT NULL CHECK (kind IN ('update', 'maintenance')),
  window_start timestamptz,
  window_end timestamptz,
  audience text NOT NULL CHECK (audience IN ('everyone', 'admins')),
  all_clients boolean NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  CHECK ((window_start IS NULL) = (window_end IS NULL)),
  CHECK (window_end IS NULL OR window_end > window_start),
  CHECK (kind = 'maintenance' OR window_start IS NULL),
  CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '60 days')
);
CREATE INDEX announcements_live ON announcements (starts_at, ends_at) WHERE withdrawn_at IS NULL;

CREATE TABLE announcement_clients (
  announcement_id uuid NOT NULL REFERENCES announcements ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients ON DELETE CASCADE,
  PRIMARY KEY (announcement_id, client_id)
);
CREATE INDEX announcement_clients_client ON announcement_clients (client_id);

-- How many people at a client pressed Got it, as its LUME last said: a count, never who.
CREATE TABLE announcement_seen (
  announcement_id uuid NOT NULL REFERENCES announcements ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients ON DELETE CASCADE,
  people integer NOT NULL CHECK (people BETWEEN 0 AND 1000000),
  at timestamptz NOT NULL,
  PRIMARY KEY (announcement_id, client_id)
);
