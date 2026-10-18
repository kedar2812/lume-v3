-- pg_dump/pg_restore run with an empty search_path: a policy helper must not depend on the caller's (as 0010's). Found
-- by the backup test: without it the nightly backup of a LUME with WhatsApp's tables failed.
ALTER FUNCTION lume_whatsapp_number_seen(uuid) SET search_path = public, pg_temp;
