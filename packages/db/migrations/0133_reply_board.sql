-- Who replied with Instagram (plan 2026-11-25-instagram-screens D6a): the board reads each lead's latest reply on either
-- channel since a moment; at a million activities that reads only the replies, newest first.
CREATE INDEX activities_replies_time ON activities (occurred_at DESC)
  WHERE type IN ('whatsapp_received', 'instagram_received');

-- A flow that passed a conversation to a person: the board reads the newest run on each conversation, ended handed.
CREATE INDEX instagram_flow_runs_handed ON instagram_flow_runs (updated_at DESC) WHERE status = 'handed';
