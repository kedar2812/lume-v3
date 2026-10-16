-- Control each client (spec 2026-10-17 control §3.1): how many places a client's LUME has (null: no limit), and the
-- modules left out of its plan ({"calendly": false}; a module not named is in it). Signed into the check-in answer.
ALTER TABLE licences ADD COLUMN places integer CHECK (places BETWEEN 1 AND 10000);
ALTER TABLE licences ADD COLUMN modules jsonb NOT NULL DEFAULT '{}'::jsonb;
