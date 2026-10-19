-- WhatsApp W3b-2 (plan 2026-10-19-whatsapp-templates Task 5): the monthly limit on paid WhatsApp messages counts every
-- lead's, whoever is sending. The person sending may not see most leads, so this one count widens the request's lead
-- scope to 'all', counts, and puts the scope back. It returns a number and nothing else.
CREATE FUNCTION lume_whatsapp_paid_count(from_at timestamptz, to_at timestamptz)
RETURNS integer LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  saved text := current_setting('lume.lead_scope', true);
  n integer;
BEGIN
  PERFORM set_config('lume.lead_scope', 'all', true);
  SELECT count(*)::int INTO n FROM whatsapp_outbox
   WHERE paid AND status <> 'failed' AND created_at >= from_at AND created_at < to_at;
  PERFORM set_config('lume.lead_scope', coalesce(saved, ''), true);
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION lume_whatsapp_paid_count(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_whatsapp_paid_count(timestamptz, timestamptz) TO lume_app;
