-- Phase 4B (plan 2026-09-29-phase-4b-saved-views): saved views — a person's own, or shared with roles —
-- and a signal on lume_leads whenever leads change, so view counts stay true without polling.

-- Who is asking, for views: their roles, and whether they manage shared views (set per request).
CREATE FUNCTION lume_role_ids() RETURNS uuid[] LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(NULLIF(current_setting('lume.role_ids', true), ''), '{}')::uuid[]
$$;
CREATE FUNCTION lume_manages_views() RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT current_setting('lume.manage_views', true) = 'on'
$$;

CREATE TABLE saved_views (
  id              uuid        PRIMARY KEY,
  name            citext      NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  color           text        NOT NULL DEFAULT 'accent',
  -- The Leads list's own filters (its API query, without paging), so a view counts as the list shows.
  filters         jsonb       NOT NULL DEFAULT '{}',
  owner_id        uuid        NOT NULL REFERENCES users (id),
  -- Empty: the owner's alone.
  shared_role_ids uuid[]      NOT NULL DEFAULT '{}',
  position        integer     NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Deleting is soft, so Undo can bring it back.
  deleted_at      timestamptz
);
CREATE INDEX saved_views_owner ON saved_views (owner_id) WHERE deleted_at IS NULL;

ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_views FORCE ROW LEVEL SECURITY;
CREATE POLICY saved_views_read ON saved_views FOR SELECT USING (
  owner_id = lume_user()
  OR shared_role_ids && lume_role_ids()
  OR (shared_role_ids <> '{}' AND lume_manages_views())
);
CREATE POLICY saved_views_create ON saved_views FOR INSERT WITH CHECK (owner_id = lume_user());
CREATE POLICY saved_views_update ON saved_views FOR UPDATE
  USING (owner_id = lume_user() OR (shared_role_ids <> '{}' AND lume_manages_views()))
  WITH CHECK (owner_id = lume_user() OR lume_manages_views());
CREATE POLICY saved_views_delete ON saved_views FOR DELETE
  USING (owner_id = lume_user() OR (shared_role_ids <> '{}' AND lume_manages_views()));
-- pg_dump runs with row security on: backups must hold every view (the 3A lesson).
CREATE POLICY backup_read ON saved_views FOR SELECT TO lume_readonly_backup USING (true);
REVOKE ALL ON saved_views FROM lume_worker;

-- Sharing views: existing installs' admins (roles that manage people) get it now; new installs through
-- the Admin preset. The boot sync keeps the permission's words.
INSERT INTO permissions (key, "group", label, description, supports_scope, retired)
VALUES ('views.manage', 'Leads', 'Share views', 'Share saved views with roles, and manage shared ones', false, false)
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key, scope)
SELECT role_id, 'views.manage', NULL FROM role_permissions WHERE permission_key = 'users.manage'
ON CONFLICT DO NOTHING;

-- Leads changed: once per statement, and Postgres folds repeats within a transaction into one.
CREATE FUNCTION lume_leads_changed() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_notify('lume_leads', '');
  RETURN NULL;
END
$$;
CREATE TRIGGER leads_changed AFTER INSERT OR UPDATE OR DELETE ON leads
  FOR EACH STATEMENT EXECUTE FUNCTION lume_leads_changed();
