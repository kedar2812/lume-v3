-- Autopilot A1 (spec 2026-10-19 §4; owner 2026-10-19: monthly, and generous): LUME AI a month per client, replacing
-- the weekly reads for a LUME that accepts plan4. Null: no limit.
ALTER TABLE licences ADD COLUMN ai_calls_monthly integer CHECK (ai_calls_monthly BETWEEN 1 AND 10000000);

-- Top-ups the owner adds, by month on the client's clock ("YYYY-MM"): added to that month's allowance at the next
-- check-in. Several in a month add up.
CREATE TABLE ai_topups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients ON DELETE CASCADE,
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  calls integer NOT NULL CHECK (calls BETWEEN 1 AND 10000000),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  added_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_topups_client ON ai_topups (client_id, month);

-- A client's admin asking for one (§4: the run stays paused until they ask): one open request a month, closed when a
-- top-up for that month is added.
CREATE TABLE topup_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients ON DELETE CASCADE,
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  asked_at timestamptz NOT NULL DEFAULT now(),
  asked_by_name text NOT NULL CHECK (length(asked_by_name) BETWEEN 1 AND 120),
  asked_by_email text NOT NULL CHECK (length(asked_by_email) BETWEEN 3 AND 254),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  done_at timestamptz
);
CREATE UNIQUE INDEX topup_requests_open ON topup_requests (client_id, month) WHERE done_at IS NULL;
