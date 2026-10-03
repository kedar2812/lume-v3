-- Phase 7A (spec 2026-10-03-phase-7-scale-design §7A.3): the read paths' indexes. Built with the app stopped, as
-- every migration is (CHANGELOG lists them).
-- Sort by name: ORDER BY lower(name), id (the list's "Name" sort and its cursor).
CREATE INDEX leads_name_sort ON leads (lower(name), id) WHERE deleted_at IS NULL;
-- "My leads, newest first": a rep's list, and a team's (owner_id = ANY(team)).
CREATE INDEX leads_owner_newest ON leads (owner_id, id DESC) WHERE deleted_at IS NULL;
-- Counts read the index, not the table: the stage strip and the board, for everyone and for one person.
CREATE INDEX leads_counts ON leads (pipeline_id, stage_id) INCLUDE (owner_id, value) WHERE deleted_at IS NULL;
CREATE INDEX leads_owner_counts ON leads (owner_id, pipeline_id, stage_id) INCLUDE (value) WHERE deleted_at IS NULL;
-- The saved views' filters (the sidebar counts each, on every page; 7A review). Their comparisons are leakproof, so
-- these serve them under row-level security.
-- "New today" and other day ranges: the enquiry date, or (without one) when the lead arrived.
CREATE INDEX leads_enquiry_day ON leads (lead_created_at) WHERE deleted_at IS NULL;
CREATE INDEX leads_arrived_undated ON leads (created_at) WHERE deleted_at IS NULL AND lead_created_at IS NULL;
-- "No reply for N days" reads leads_last_message (0026).
-- "Lost N+ days ago".
CREATE INDEX leads_lost_at ON leads (lost_at) WHERE deleted_at IS NULL AND lost_at IS NOT NULL;
-- "Overdue follow-up": open follow-ups by when they were due.
CREATE INDEX tasks_open_due ON tasks (due_at) WHERE status = 'open';
-- A lead by id with what visibility and counting need (owner, pipeline, stage), read from the index alone: the tag
-- filter and its counts look up each tagged lead this way.
CREATE INDEX leads_id_counting ON leads (id) INCLUDE (owner_id, pipeline_id, stage_id) WHERE deleted_at IS NULL;
