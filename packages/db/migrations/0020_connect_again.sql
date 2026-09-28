-- 2B-2 final review: "Connect again" — a connect started from an existing sheet gives that sheet a new grant.
ALTER TABLE oauth_connects ADD COLUMN target_source_id uuid REFERENCES lead_sources (id) ON DELETE CASCADE;
