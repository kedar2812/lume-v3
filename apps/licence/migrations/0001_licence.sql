-- The licence server (licensing L-B, spec §4.2): its own database, never a client's.

-- The one admin (R4), and how they sign in.
CREATE TABLE admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  password_hash text NOT NULL,
  -- AES-256-GCM under LICENCE_MASTER_KEY, bound to the admin's id.
  totp_secret bytea NOT NULL,
  totp_last_step bigint,
  -- A new two-step secret, sealed, until a code from it confirms the switch.
  totp_pending bytea,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE admin_sessions (
  -- SHA-256 of the cookie's token: a database read never yields a usable session.
  id bytea PRIMARY KEY,
  admin_id uuid NOT NULL REFERENCES admins ON DELETE CASCADE,
  -- The double-submit token: a write must send it back in x-csrf-token.
  csrf text NOT NULL,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX admin_sessions_admin ON admin_sessions (admin_id);
-- Between the password and the six digits. Made whatever the password was, so the first step never says
-- whether it was right: only the code step decides, and it doesn't say which was wrong.
CREATE TABLE sign_in_pending (
  id bytea PRIMARY KEY,
  admin_id uuid REFERENCES admins ON DELETE CASCADE,
  password_ok boolean NOT NULL,
  email text NOT NULL,
  ip text,
  expires_at timestamptz NOT NULL
);
-- Every sign-in, good or not.
CREATE TABLE sign_ins (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  ip text,
  email text,
  outcome text NOT NULL CHECK (outcome IN ('ok', 'bad_password', 'bad_code', 'unknown_email', 'limited', 'expired', 'signed_out'))
);

CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  -- The subdomain.
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  country text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  -- An Indian state or union territory's code, for India only.
  region text CHECK (region IS NULL OR (country = 'IN' AND region ~ '^[A-Z]{2}$')),
  city text CHECK (city IS NULL OR length(city) <= 80),
  -- How they found LUME.
  source text NOT NULL CHECK (source IN ('referrals', 'demo', 'website', 'instagram', 'other')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decommissioned_at timestamptz
);

-- One per client.
CREATE TABLE licences (
  client_id uuid PRIMARY KEY REFERENCES clients ON DELETE CASCADE,
  instance_id text NOT NULL UNIQUE CHECK (instance_id ~ '^LUME-[0-9A-Z]{4}-[0-9A-Z]{4}$'),
  -- SHA-256 of the key as typed out once; only its last four are kept in the clear.
  key_hash bytea NOT NULL CHECK (length(key_hash) = 32),
  key_last4 text NOT NULL,
  type text NOT NULL CHECK (type IN ('subscription', 'perpetual', 'trial')),
  paid_until date,
  trial_ends date,
  suspended_at timestamptz,
  -- When its monthly revenue began: at creation for a subscription, at the first payment for a trial.
  paying_since timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (type <> 'trial' OR trial_ends IS NOT NULL)
);

-- A change of price adds a row (what powers "Price up" and "Price down").
CREATE TABLE prices (
  id bigserial PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES clients ON DELETE CASCADE,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount numeric(14, 2) NOT NULL CHECK (amount >= 0),
  -- 1, 3 or 12 months; 0 is a one-time price.
  period_months smallint NOT NULL CHECK (period_months IN (0, 1, 3, 12)),
  effective_from timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prices_client ON prices (client_id, effective_from DESC, id DESC);

CREATE TABLE payments (
  id bigserial PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES clients ON DELETE CASCADE,
  amount numeric(14, 2) NOT NULL CHECK (amount >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- The rate on the day it was marked paid, kept; null when no rate was known that day.
  rate_to_inr numeric(20, 10),
  amount_inr numeric(14, 2),
  paid_at timestamptz NOT NULL DEFAULT now(),
  paid_until date,
  note text CHECK (note IS NULL OR length(note) <= 500)
);
CREATE INDEX payments_paid_at ON payments (paid_at DESC);
CREATE INDEX payments_client ON payments (client_id, paid_at DESC);

-- Kept 180 days (R3).
CREATE TABLE check_ins (
  id bigserial PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES clients ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  ip text,
  app_version text NOT NULL,
  active_users integer NOT NULL,
  lead_count integer NOT NULL,
  server_time timestamptz,
  state text NOT NULL
);
CREATE INDEX check_ins_client ON check_ins (client_id, at DESC, id DESC);
CREATE INDEX check_ins_at ON check_ins (at);

-- Payment reminders: at most one open per client.
CREATE TABLE notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients ON DELETE CASCADE,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  due_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz
);
CREATE UNIQUE INDEX notices_one_open ON notices (client_id) WHERE cleared_at IS NULL;

-- A day's exchange rates, from open.er-api.com (R2).
CREATE TABLE fx_rates (
  day date NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- One unit of the currency, in rupees.
  rate_to_inr numeric(20, 10) NOT NULL CHECK (rate_to_inr > 0),
  PRIMARY KEY (day, currency)
);

-- A client's history, kept forever.
CREATE TABLE events (
  id bigserial PRIMARY KEY,
  client_id uuid REFERENCES clients ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX events_client ON events (client_id, at DESC, id DESC);

CREATE TABLE settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- What LUME costs a month, in rupees, to compare each client's price with.
  list_price_inr numeric(14, 2) NOT NULL DEFAULT 0 CHECK (list_price_inr >= 0),
  latest_version text,
  -- Where "Contact about payment" goes: a mailto:, tel: or https: link.
  billing_contact text CHECK (billing_contact IS NULL OR billing_contact ~ '^(mailto:|tel:|https:)'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO settings (id) VALUES (1);

-- A hidden alert stays hidden only while its condition is the same (its fingerprint).
CREATE TABLE alert_dismissals (
  alert_id text PRIMARY KEY,
  fingerprint text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
