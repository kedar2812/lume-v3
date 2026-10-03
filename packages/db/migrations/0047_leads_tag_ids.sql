-- Phase 7A (spec 2026-10-03-phase-7-scale-design §7A.4): each lead carries its tags, so the tag filter is an index
-- probe on the lead (no join, no second row-level-security check) and a page needs no tags query. lead_tags stays
-- the source of truth; these triggers keep tag_ids equal to it after every statement, whoever's scope it ran in.
ALTER TABLE leads ADD COLUMN tag_ids uuid[] NOT NULL DEFAULT '{}';

-- LUME's own bookkeeping: recompute the tags of these leads from lead_tags. It runs across every lead (a tag
-- deleted by someone who can't see every lead still leaves no lead holding it) and puts the caller's settings back.
-- The leads are locked first, so a concurrent change waits and the recount then sees it (no lost update).
CREATE FUNCTION lead_tags_sync(lead_ids uuid[]) RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  saved_scope text := current_setting('lume.lead_scope', true);
  saved_user text := current_setting('lume.user_id', true);
BEGIN
  IF lead_ids IS NULL OR cardinality(lead_ids) = 0 THEN RETURN; END IF;
  PERFORM set_config('lume.lead_scope', 'all', true);
  -- leads_update's WITH CHECK wants a user; a session with none (a cascade from housekeeping) borrows LUME's nil id.
  IF coalesce(saved_user, '') = '' THEN
    PERFORM set_config('lume.user_id', '00000000-0000-0000-0000-000000000000', true);
  END IF;
  PERFORM 1 FROM leads WHERE id = ANY(lead_ids) ORDER BY id FOR UPDATE;
  PERFORM set_config('lume.tag_sync', 'on', true);
  UPDATE leads l
     SET tag_ids = coalesce((SELECT array_agg(t.tag_id ORDER BY t.tag_id) FROM lead_tags t WHERE t.lead_id = l.id), '{}')
   WHERE l.id = ANY(lead_ids);
  PERFORM set_config('lume.tag_sync', '', true);
  PERFORM set_config('lume.lead_scope', coalesce(saved_scope, ''), true);
  PERFORM set_config('lume.user_id', coalesce(saved_user, ''), true);
END $$;

-- Nothing else writes tag_ids: a direct write is refused, so no code path can make it drift from lead_tags.
CREATE FUNCTION leads_tag_ids_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF coalesce(current_setting('lume.tag_sync', true), '') <> 'on'
     AND ((TG_OP = 'INSERT' AND NEW.tag_ids <> '{}') OR (TG_OP = 'UPDATE' AND NEW.tag_ids IS DISTINCT FROM OLD.tag_ids)) THEN
    RAISE EXCEPTION 'tag_ids follows lead_tags: add or remove the lead''s tags there';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER leads_tag_ids_guarded BEFORE INSERT OR UPDATE OF tag_ids ON leads
  FOR EACH ROW EXECUTE FUNCTION leads_tag_ids_guard();

CREATE FUNCTION lead_tags_after_insert() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM lead_tags_sync(ARRAY(SELECT DISTINCT lead_id FROM new_rows));
  RETURN NULL;
END $$;
CREATE FUNCTION lead_tags_after_delete() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM lead_tags_sync(ARRAY(SELECT DISTINCT lead_id FROM old_rows));
  RETURN NULL;
END $$;

CREATE TRIGGER lead_tags_synced_insert AFTER INSERT ON lead_tags REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION lead_tags_after_insert();
CREATE TRIGGER lead_tags_synced_delete AFTER DELETE ON lead_tags REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION lead_tags_after_delete();

-- The backfill: every lead that already has tags, as the table owner with every lead in scope.
SELECT set_config('lume.lead_scope', 'all', true), set_config('lume.user_id', '00000000-0000-0000-0000-000000000000', true),
       set_config('lume.tag_sync', 'on', true);
UPDATE leads l SET tag_ids = s.ids
  FROM (SELECT lead_id, array_agg(tag_id ORDER BY tag_id) AS ids FROM lead_tags GROUP BY lead_id) s
 WHERE s.lead_id = l.id;
SELECT set_config('lume.lead_scope', '', true), set_config('lume.user_id', '', true), set_config('lume.tag_sync', '', true);

CREATE INDEX leads_tag_ids ON leads USING gin (tag_ids) WHERE deleted_at IS NULL;
