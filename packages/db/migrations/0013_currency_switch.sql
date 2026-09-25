-- One currency across LUME (owner decision 2026-09-25): switching it converts every amount once, at
-- the rate the admin confirmed. The admin may not see every lead under their own scope, so this one
-- statement widens the request's lead scope to 'all' and restores it before returning. The API holds
-- the settings row lock and audits the call.
CREATE FUNCTION convert_amounts(rate numeric, currency_keys text[])
RETURNS TABLE (leads integer, products integer)
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  saved text := current_setting('lume.lead_scope', true);
  l integer;
  p integer;
  k text;
BEGIN
  PERFORM set_config('lume.lead_scope', 'all', true);
  UPDATE leads SET value = round(value * rate, 2), version = version + 1
  WHERE value IS NOT NULL AND deleted_at IS NULL;
  GET DIAGNOSTICS l = ROW_COUNT;
  FOREACH k IN ARRAY currency_keys LOOP
    UPDATE leads SET custom = jsonb_set(custom, ARRAY[k], to_jsonb(round((custom->>k)::numeric * rate, 2)))
    WHERE deleted_at IS NULL AND jsonb_typeof(custom->k) = 'number';
  END LOOP;
  UPDATE products SET default_value = round(default_value * rate, 2) WHERE default_value IS NOT NULL;
  GET DIAGNOSTICS p = ROW_COUNT;
  PERFORM set_config('lume.lead_scope', coalesce(saved, ''), true);
  RETURN QUERY SELECT l, p;
END $$;
REVOKE ALL ON FUNCTION convert_amounts(numeric, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION convert_amounts(numeric, text[]) TO lume_app;

-- About reads the last restore test.
GRANT SELECT ON ops_restore_tests TO lume_app;
