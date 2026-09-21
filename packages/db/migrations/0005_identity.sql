-- Identity, access and settings (report §5.1, §5.2 settings). Lead tables arrive in Phase 1B.
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TABLE settings (
  id                  smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  business_name       text        NOT NULL,
  logo_asset_id       uuid,
  timezone            text        NOT NULL,
  currency            char(3)     NOT NULL,
  default_country_iso char(2)     NOT NULL,
  week_start          smallint    NOT NULL DEFAULT 1 CHECK (week_start BETWEEN 0 AND 6),
  working_hours       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  digest_default_time time        NOT NULL DEFAULT '08:00',
  industry_preset     text        NOT NULL,
  security            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  retention           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  field_defs_version  integer     NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                   uuid        PRIMARY KEY,
  email                citext      NOT NULL UNIQUE,
  name                 text        NOT NULL,
  password_hash        text,
  status               text        NOT NULL CHECK (status IN ('invited', 'active', 'disabled')),
  is_owner             boolean     NOT NULL DEFAULT false,
  timezone             text,
  theme                text        NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'porcelain', 'obsidian')),
  totp_secret_enc      bytea,
  totp_pending_enc     bytea,
  totp_enabled         boolean     NOT NULL DEFAULT false,
  totp_last_step       bigint,
  must_change_password boolean     NOT NULL DEFAULT false,
  last_login_at        timestamptz,
  disabled_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_one_owner ON users ((true)) WHERE is_owner;

CREATE TABLE roles (
  id           uuid        PRIMARY KEY,
  name         citext      NOT NULL,
  description  text        NOT NULL DEFAULT '',
  color        text        NOT NULL DEFAULT 'accent',
  login_hours  jsonb,
  ip_allowlist cidr[],
  created_by   uuid        REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE UNIQUE INDEX roles_live_name ON roles (name) WHERE deleted_at IS NULL;

CREATE TABLE permissions (
  key            text    PRIMARY KEY,
  "group"        text    NOT NULL,
  label          text    NOT NULL,
  description    text    NOT NULL,
  supports_scope boolean NOT NULL,
  retired        boolean NOT NULL DEFAULT false
);

CREATE TABLE role_permissions (
  role_id        uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions (key),
  scope          text CHECK (scope IN ('own', 'team', 'all')),
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles (id),
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX user_roles_role ON user_roles (role_id);

CREATE TABLE teams (
  id         uuid        PRIMARY KEY,
  name       citext      NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX teams_live_name ON teams (name) WHERE deleted_at IS NULL;

CREATE TABLE team_members (
  team_id uuid    NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  user_id uuid    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  is_lead boolean NOT NULL DEFAULT false,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user ON team_members (user_id);

CREATE TABLE sessions (
  id             text        PRIMARY KEY, -- sha256(token); the token itself is never stored
  user_id        uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  stage          text        NOT NULL CHECK (stage IN ('mfa', 'full')),
  ip             inet,
  user_agent     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text
);
CREATE INDEX sessions_live_user ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE recovery_codes (
  id        uuid        PRIMARY KEY,
  user_id   uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash text        NOT NULL,
  used_at   timestamptz,
  UNIQUE (user_id, code_hash)
);

CREATE TABLE user_invites (
  id          uuid        PRIMARY KEY,
  email       citext      NOT NULL,
  name        text        NOT NULL,
  role_ids    uuid[]      NOT NULL,
  token_hash  text        NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  invited_by  uuid        REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE password_resets (
  id         uuid        PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text        NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_throttle (
  key               text        PRIMARY KEY, -- 'ip:<addr>' or 'acct:<sha256(email)>'
  failures          integer     NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  next_allowed_at   timestamptz,
  locked_until      timestamptz,
  lockouts          integer     NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crypto_keys (
  id         uuid        PRIMARY KEY,
  wrapped    bytea       NOT NULL,
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX crypto_keys_one_active ON crypto_keys ((true)) WHERE active;

CREATE TRIGGER settings_updated_at BEFORE UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER roles_updated_at BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER teams_updated_at BEFORE UPDATE ON teams FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER auth_throttle_updated_at BEFORE UPDATE ON auth_throttle FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The worker never touches identity secrets.
REVOKE ALL ON sessions, recovery_codes, password_resets, user_invites, auth_throttle, crypto_keys FROM lume_worker;
