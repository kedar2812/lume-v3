-- Phase 4B: each person's own order of their saved views (plan ruling R2). Not in preferences: a
-- preferences save rewrites the whole object and would drop it.
ALTER TABLE users ADD COLUMN view_order uuid[] NOT NULL DEFAULT '{}';
