-- Flows as a graph (plan 2026-11-23-flow-builder, Task A3). A graph version is kept in the same jsonb as 1B's lists
-- (instagram_flows.draft_steps, instagram_flow_versions.steps), marked {"v": 2}: no new columns for the flow itself.

-- Each step a run enters, for the numbers on every step and Replay (step_key: the step's id, or id:visit from its
-- second time in one run). One per run and key: the existing unique index keeps a job that runs twice from counting
-- twice.
ALTER TABLE instagram_flow_events DROP CONSTRAINT instagram_flow_events_kind_check;
ALTER TABLE instagram_flow_events ADD CONSTRAINT instagram_flow_events_kind_check
  CHECK (kind IN ('triggered', 'private_reply', 'dm_sent', 'replied', 'lead_created', 'call_booked', 'handed', 'entered'));

-- The numbers read one kind of event over a range: each kind its own slice of the index, however busy the flow.
CREATE INDEX instagram_flow_events_kind ON instagram_flow_events (flow_id, kind, at);

-- Replay: one lead's runs, newest first.
CREATE INDEX instagram_flow_runs_lead ON instagram_flow_runs (lead_id, created_at DESC);
