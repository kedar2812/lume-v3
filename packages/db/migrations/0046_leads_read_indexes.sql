-- Phase 7A (spec 2026-10-03-phase-7-scale-design §7A.3): the read paths' indexes. Built with the app stopped, as
-- every migration is (CHANGELOG lists them).
-- Sort by name: ORDER BY lower(name), id (the list's "Name" sort and its cursor).
CREATE INDEX leads_name_sort ON leads (lower(name), id) WHERE deleted_at IS NULL;
-- "My leads, newest first": a rep's list, and a team's (owner_id = ANY(team)).
CREATE INDEX leads_owner_newest ON leads (owner_id, id DESC) WHERE deleted_at IS NULL;
-- Counts read the index, not the table: the stage strip and the board, for everyone and for one person.
CREATE INDEX leads_counts ON leads (pipeline_id, stage_id) INCLUDE (owner_id, value) WHERE deleted_at IS NULL;
CREATE INDEX leads_owner_counts ON leads (owner_id, pipeline_id, stage_id) INCLUDE (value) WHERE deleted_at IS NULL;
