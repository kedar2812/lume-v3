-- Product key activation (spec 2026-10-15 §2): a key is bound to the one install that activated it, kept sealed so
-- the owner can copy it again, and a retired key (rotated or decommissioned) never works anywhere again.
ALTER TABLE licences
  -- The key, sealed with LICENCE_MASTER_KEY (purpose "key:<client id>"); null for licences made before this.
  ADD COLUMN key_enc bytea,
  -- The install that activated it (its own random id), and when and from where.
  ADD COLUMN install_id uuid,
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN activated_ip text,
  -- Released for a new server: only a key entered by hand (/v1/activate) binds it again.
  ADD COLUMN released_at timestamptz,
  -- Decommissioned on the card: no live key until "Issue a new key".
  ADD COLUMN key_dead_at timestamptz;
CREATE UNIQUE INDEX licences_key_hash ON licences (key_hash);

CREATE TABLE retired_keys (
  key_hash bytea PRIMARY KEY CHECK (length(key_hash) = 32),
  client_id uuid NOT NULL REFERENCES clients ON DELETE CASCADE,
  key_last4 text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('rotated', 'decommissioned')),
  retired_at timestamptz NOT NULL,
  -- The install that held it when it was retired: a rotated key keeps working there for 7 days.
  install_id uuid
);
CREATE INDEX retired_keys_client ON retired_keys (client_id, retired_at DESC);
