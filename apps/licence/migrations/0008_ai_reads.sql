-- LUME AI's limits per client (spec 2026-10-18 §2.2): reads in a rolling hour, and in a week from Monday 00:00 on the
-- client's clock. Null: no limit. Signed into the check-in answer for a LUME that accepts plan2.
ALTER TABLE licences ADD COLUMN ai_reads_hourly integer CHECK (ai_reads_hourly BETWEEN 1 AND 100000);
ALTER TABLE licences ADD COLUMN ai_reads_weekly integer CHECK (ai_reads_weekly BETWEEN 1 AND 1000000);
