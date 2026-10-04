-- Phase 8A (spec 2026-10-04-phase-8-analytics-design §3): when each lead was first contacted and first replied,
-- kept as activities arrive, so contact and reply rates, and speed to lead, are indexed reads rather than scans of
-- every activity. First contact is the first message opened in WhatsApp, call logged or meeting booked; first reply
-- is the first reply logged.
--
-- Kept beside leads, not on them: leads is FORCE row-level security, and an activity written by LUME itself (a
-- booking from Calendly, an automation) has no person to update a lead as; writing here also leaves a lead's
-- version, updated_at and the "leads changed" signal untouched. Read joined to leads, under leads' own security.
CREATE TABLE lead_firsts (
  lead_id          uuid        PRIMARY KEY REFERENCES leads (id) ON DELETE CASCADE,
  first_contact_at timestamptz,
  first_reply_at   timestamptz
);

CREATE FUNCTION lume_first_touch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.type = 'reply_logged' THEN
    INSERT INTO lead_firsts (lead_id, first_reply_at) VALUES (NEW.lead_id, NEW.occurred_at)
    ON CONFLICT (lead_id) DO UPDATE
      SET first_reply_at = least(coalesce(lead_firsts.first_reply_at, 'infinity'), EXCLUDED.first_reply_at);
  ELSE
    INSERT INTO lead_firsts (lead_id, first_contact_at) VALUES (NEW.lead_id, NEW.occurred_at)
    ON CONFLICT (lead_id) DO UPDATE
      SET first_contact_at = least(coalesce(lead_firsts.first_contact_at, 'infinity'), EXCLUDED.first_contact_at);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER activities_first_touch AFTER INSERT ON activities FOR EACH ROW
  WHEN (NEW.type IN ('whatsapp_opened', 'call_logged', 'meeting_booked', 'reply_logged'))
  EXECUTE FUNCTION lume_first_touch();

-- Everything already recorded: every lead's activities, as the table owner with every lead in scope (activities are
-- read through leads' row-level security).
SELECT set_config('lume.lead_scope', 'all', true);
INSERT INTO lead_firsts (lead_id, first_contact_at, first_reply_at)
SELECT lead_id,
       min(occurred_at) FILTER (WHERE type IN ('whatsapp_opened', 'call_logged', 'meeting_booked')),
       min(occurred_at) FILTER (WHERE type = 'reply_logged')
FROM activities
WHERE type IN ('whatsapp_opened', 'call_logged', 'meeting_booked', 'reply_logged')
GROUP BY lead_id;
SELECT set_config('lume.lead_scope', '', true);

GRANT SELECT ON lead_firsts TO lume_app;
REVOKE ALL ON lead_firsts FROM lume_worker;
