-- Autopilot's live view (spec 2026-10-19 §2.2: a window onto the run, on the stream LUME already uses): every change in
-- a run, wherever it was written, is said on lume_autopilot as its run, lead and kind. Never words: each screen reads
-- what it may see under its own access.
CREATE FUNCTION lume_autopilot_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('lume_autopilot', json_build_object('run', NEW.run_id, 'lead', NEW.lead_id, 'kind', NEW.kind)::text);
  RETURN NEW;
END $$;
CREATE TRIGGER autopilot_events_live AFTER INSERT ON autopilot_events FOR EACH ROW EXECUTE FUNCTION lume_autopilot_notify();

-- A run's history is kept 90 days (spec §2.2), as read notifications are: the worker's retention sweep may see when each
-- event happened and delete it, every lead's included, and nothing more.
REVOKE ALL ON autopilot_events FROM lume_worker;
GRANT SELECT (id, at), DELETE ON autopilot_events TO lume_worker;
CREATE POLICY autopilot_events_sweep_read ON autopilot_events FOR SELECT TO lume_worker USING (true);
CREATE POLICY autopilot_events_sweep ON autopilot_events FOR DELETE TO lume_worker USING (true);
