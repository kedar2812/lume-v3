-- Review 2026-10-26 D4, D5: switching the business currency converts every amount there is, once, at the confirmed
-- rate. As 0013, and also: leads in the bin (Undo brings them back in the business's currency), each source's monthly
-- spend, revenue goals' targets, and the won value Analytics has already added up; and the code a lead or product
-- still carries becomes the new one. The counts returned are what the admin was shown: live leads and products.
DROP FUNCTION convert_amounts(numeric, text[]);

-- Only definer functions write the rollups (0053): this one scales the money in them and nothing else.
CREATE FUNCTION lume_convert_rollups(rate numeric) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE analytics_daily_event SET won_value = round(won_value * rate, 2) WHERE won_value <> 0;
END $$;
REVOKE ALL ON FUNCTION lume_convert_rollups(numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_convert_rollups(numeric) TO lume_app;

CREATE FUNCTION convert_amounts(rate numeric, currency_keys text[], to_code text)
RETURNS TABLE (leads integer, products integer)
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  saved text := current_setting('lume.lead_scope', true);
  l integer;
  p integer;
  k text;
BEGIN
  PERFORM set_config('lume.lead_scope', 'all', true);
  SELECT count(*)::int INTO l FROM leads WHERE value IS NOT NULL AND deleted_at IS NULL;
  UPDATE leads SET value = round(value * rate, 2), version = version + 1 WHERE value IS NOT NULL;
  UPDATE leads SET currency = to_code WHERE currency IS NOT NULL AND currency <> to_code;
  FOREACH k IN ARRAY currency_keys LOOP
    UPDATE leads SET custom = jsonb_set(custom, ARRAY[k], to_jsonb(round((custom->>k)::numeric * rate, 2)))
    WHERE jsonb_typeof(custom->k) = 'number';
  END LOOP;
  UPDATE products SET default_value = round(default_value * rate, 2) WHERE default_value IS NOT NULL;
  GET DIAGNOSTICS p = ROW_COUNT;
  UPDATE products SET currency = to_code WHERE currency IS NOT NULL AND currency <> to_code;
  UPDATE lead_sources SET monthly_spend = round(monthly_spend * rate, 2) WHERE monthly_spend IS NOT NULL;
  UPDATE goals SET target = round(target * rate, 2), updated_at = now() WHERE metric = 'revenue';
  PERFORM lume_convert_rollups(rate);
  PERFORM set_config('lume.lead_scope', coalesce(saved, ''), true);
  RETURN QUERY SELECT l, p;
END $$;
REVOKE ALL ON FUNCTION convert_amounts(numeric, text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION convert_amounts(numeric, text[], text) TO lume_app;
