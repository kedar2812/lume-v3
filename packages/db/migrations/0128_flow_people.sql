-- Replay's list of who went through a flow, newest first (plan 2026-11-23-flow-builder, Task B4): the flow's runs read
-- from the newest down, however many there are.
CREATE INDEX instagram_flow_runs_flow_recent ON instagram_flow_runs (flow_id, created_at DESC);
