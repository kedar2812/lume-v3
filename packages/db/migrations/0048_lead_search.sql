-- Phase 7A (Task 4): search through its own table.
-- Under row-level security Postgres can only use an index for a condition whose operator is leakproof. LIKE and
-- ILIKE aren't (texticlike, textlike), so no index on leads could ever serve a search: every search read every
-- lead (about 170 ms at 200,000; seconds at 2,000,000). lead_search mirrors what search needs. The app can't read
-- it; lume_lead_search reads it, applying the leads policies' rule itself, and returns only lead ids. The page is
-- then read from leads under its own row-level security, so even a wrong id here could never show a lead.
CREATE TABLE lead_search (
  lead_id      uuid    PRIMARY KEY REFERENCES leads (id) ON DELETE CASCADE,
  owner_id     uuid,
  live         boolean NOT NULL,
  name         text    NOT NULL,
  email        text,
  instagram    text,
  phone_digits text
);
CREATE INDEX lead_search_name ON lead_search USING gin (name gin_trgm_ops) WHERE live;
CREATE INDEX lead_search_email ON lead_search USING gin (email gin_trgm_ops) WHERE live;
CREATE INDEX lead_search_instagram ON lead_search USING gin (instagram gin_trgm_ops) WHERE live;
CREATE INDEX lead_search_phone ON lead_search USING gin (phone_digits gin_trgm_ops) WHERE live;
CREATE INDEX lead_search_prefix ON lead_search (lower(name) text_pattern_ops) WHERE live;
CREATE INDEX lead_search_owner ON lead_search (owner_id) WHERE live;
-- Not the app's, not the worker's (new tables are theirs by default, 0002). Backups still read it.
REVOKE ALL ON lead_search FROM lume_app, lume_worker;

-- Kept in step with leads by LUME (definer: the app can't write lead_search itself).
CREATE FUNCTION lead_search_sync() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO lead_search (lead_id, owner_id, live, name, email, instagram, phone_digits)
  VALUES (NEW.id, NEW.owner_id, NEW.deleted_at IS NULL, NEW.name, NEW.email::text, NEW.instagram_handle::text,
          NULLIF(NEW.phone_digits, ''))
  ON CONFLICT (lead_id) DO UPDATE
    SET owner_id = EXCLUDED.owner_id, live = EXCLUDED.live, name = EXCLUDED.name, email = EXCLUDED.email,
        instagram = EXCLUDED.instagram, phone_digits = EXCLUDED.phone_digits;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION lead_search_sync() FROM PUBLIC;
CREATE TRIGGER lead_search_synced
  AFTER INSERT OR UPDATE OF name, email, instagram_handle, phone_e164, phone_raw, owner_id, deleted_at ON leads
  FOR EACH ROW EXECUTE FUNCTION lead_search_sync();

-- Search. Each pattern is already escaped by the app; a null pattern is a branch not asked for (the app decides
-- which branches a person may use: masked roles search names only; a hidden field is never searched). Visibility mirrors leads_read exactly, without the
-- hand-off allowance (that's for reading one lead being handed away, never for search): 'all' sees every lead;
-- any other scope needs a user and sees their leads, 'team' adds the team's. Planned with the real patterns
-- (EXECUTE), and with sequential scans off for this call only: Postgres overestimates how much "%term%" matches.
CREATE FUNCTION lume_lead_search(name_like text, prefix_like text, email_like text, instagram_like text, digits_like text,
                                 max_rows int)
RETURNS SETOF uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp SET enable_seqscan = off AS $$
DECLARE
  branches text[] := '{}';
  scope text := lume_scope();
  usr uuid := lume_user();
  vis text;
BEGIN
  IF name_like IS NOT NULL THEN branches := branches || format('s.name ILIKE %L', name_like); END IF;
  IF prefix_like IS NOT NULL THEN branches := branches || format('lower(s.name) LIKE %L', prefix_like); END IF;
  IF email_like IS NOT NULL THEN branches := branches || format('s.email ILIKE %L', email_like); END IF;
  IF instagram_like IS NOT NULL THEN branches := branches || format('s.instagram ILIKE %L', instagram_like); END IF;
  IF digits_like IS NOT NULL THEN branches := branches || format('s.phone_digits LIKE %L', digits_like); END IF;
  IF cardinality(branches) = 0 OR coalesce(max_rows, 0) <= 0 THEN RETURN; END IF;
  IF scope = 'all' THEN
    vis := 'true';
  ELSIF usr IS NULL THEN
    RETURN;
  ELSIF scope = 'team' THEN
    vis := format('(s.owner_id = %L OR s.owner_id = ANY (%L::uuid[]))', usr, lume_team_members());
  ELSE
    vis := format('s.owner_id = %L', usr);
  END IF;
  RETURN QUERY EXECUTE format('SELECT s.lead_id FROM lead_search s WHERE s.live AND %s AND (%s) LIMIT %s',
                              vis, array_to_string(branches, ' OR '), least(max_rows, 100000));
END $$;
REVOKE ALL ON FUNCTION lume_lead_search(text, text, text, text, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_lead_search(text, text, text, text, text, int) TO lume_app;

-- The backfill: every lead, as the table owner with every lead in scope.
SELECT set_config('lume.lead_scope', 'all', true);
INSERT INTO lead_search (lead_id, owner_id, live, name, email, instagram, phone_digits)
SELECT id, owner_id, deleted_at IS NULL, name, email::text, instagram_handle::text, NULLIF(phone_digits, '') FROM leads;
SELECT set_config('lume.lead_scope', '', true);
