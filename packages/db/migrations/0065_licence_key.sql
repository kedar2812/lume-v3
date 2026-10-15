-- Product key activation (spec 2026-10-15 §1.2): this install's own random id (sent with every check, so its key
-- works on this server only), and the key the owner gave, sealed, with the instance id the licence server named.
ALTER TABLE licence_state
  ADD COLUMN install_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN license_key_enc bytea,
  ADD COLUMN instance_id text,
  ADD COLUMN activated_at timestamptz;
