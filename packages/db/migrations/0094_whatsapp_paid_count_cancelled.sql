-- Review 2026-10-26 D3: a paid message LUME AI's pause cancelled never went, so it doesn't count towards the monthly
-- limit on paid WhatsApp messages, as a failed one doesn't. Otherwise as 0079: every lead's, whoever asks.
CREATE OR REPLACE FUNCTION lume_whatsapp_paid_count(from_at timestamptz, to_at timestamptz)
RETURNS integer LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  saved text := current_setting('lume.lead_scope', true);
  n integer;
BEGIN
  PERFORM set_config('lume.lead_scope', 'all', true);
  SELECT count(*)::int INTO n FROM whatsapp_outbox
   WHERE paid AND status NOT IN ('failed', 'cancelled') AND created_at >= from_at AND created_at < to_at;
  PERFORM set_config('lume.lead_scope', coalesce(saved, ''), true);
  RETURN n;
END $$;
