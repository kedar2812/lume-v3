-- Request-scoped settings the API sets with set_config(..., is_local => true) at the start of every
-- request transaction (report §7.4). Without them every helper returns NULL/empty: policies fail closed.
CREATE FUNCTION lume_user() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('lume.user_id', true), '')::uuid
$$;

CREATE FUNCTION lume_scope() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('lume.lead_scope', true), '')
$$;

CREATE FUNCTION lume_team_members() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('lume.team_member_ids', true), '')::uuid[], '{}'::uuid[])
$$;
