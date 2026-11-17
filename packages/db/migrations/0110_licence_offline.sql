-- Time without a good licence check-in, on LUME's own running clock (bug hunt 2026-11-17): the wall clock can be held
-- back while the licence server is blocked; this can't. Reset to 0 by every good check-in.
ALTER TABLE licence_state ADD COLUMN offline_ms bigint NOT NULL DEFAULT 0;
