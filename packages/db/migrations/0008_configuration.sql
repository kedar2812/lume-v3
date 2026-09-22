-- Configuration (report §5.2, §6). Admin-editable; seeded from a code-defined industry preset at setup.
CREATE TABLE pipelines (
  id          uuid        PRIMARY KEY,
  name        citext      NOT NULL,
  is_default  boolean     NOT NULL DEFAULT false,
  position    integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX pipelines_live_name ON pipelines (name) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX pipelines_one_default ON pipelines ((true)) WHERE is_default AND archived_at IS NULL;

CREATE TABLE stages (
  id                 uuid          PRIMARY KEY,
  pipeline_id        uuid          NOT NULL REFERENCES pipelines (id),
  name               text          NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  color              text          NOT NULL DEFAULT 'neutral',
  position           integer       NOT NULL DEFAULT 0,
  kind               text          NOT NULL CHECK (kind IN ('open', 'won', 'lost')),
  win_probability    numeric(5, 2) CHECK (win_probability BETWEEN 0 AND 100),
  sla_hours          integer       CHECK (sla_hours > 0),
  required_field_ids uuid[]        NOT NULL DEFAULT '{}',
  on_enter           jsonb         NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz   NOT NULL DEFAULT now(),
  updated_at         timestamptz   NOT NULL DEFAULT now(),
  archived_at        timestamptz,
  UNIQUE (id, pipeline_id) -- lets leads reference (stage, pipeline) together
);
CREATE UNIQUE INDEX stages_live_name ON stages (pipeline_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE field_definitions (
  id            uuid        PRIMARY KEY,
  entity        text        NOT NULL DEFAULT 'lead' CHECK (entity = 'lead'),
  key           text        NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label         text        NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  type          text        NOT NULL CHECK (type IN ('text','long_text','number','currency','date','datetime','boolean',
                                                     'select','multi_select','phone','email','url','user','instagram')),
  options       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  is_core       boolean     NOT NULL DEFAULT false,
  is_required   boolean     NOT NULL DEFAULT false,
  is_unique     boolean     NOT NULL DEFAULT false,
  is_searchable boolean     NOT NULL DEFAULT false,
  position      integer     NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  CHECK (NOT (is_core AND archived_at IS NOT NULL))
);

CREATE TABLE lost_reasons (
  id          uuid        PRIMARY KEY,
  label       citext      NOT NULL,
  position    integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX lost_reasons_live_label ON lost_reasons (label) WHERE archived_at IS NULL;

CREATE TABLE tags (
  id         uuid        PRIMARY KEY,
  label      citext      NOT NULL UNIQUE,
  color      text        NOT NULL DEFAULT 'neutral',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id            uuid           PRIMARY KEY,
  name          citext         NOT NULL,
  default_value numeric(14, 2) CHECK (default_value >= 0),
  currency      char(3),
  created_at    timestamptz    NOT NULL DEFAULT now(),
  updated_at    timestamptz    NOT NULL DEFAULT now(),
  archived_at   timestamptz
);
CREATE UNIQUE INDEX products_live_name ON products (name) WHERE archived_at IS NULL;

CREATE TABLE role_field_access (
  role_id  uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  field_id uuid NOT NULL REFERENCES field_definitions (id) ON DELETE CASCADE,
  access   text NOT NULL CHECK (access IN ('hidden', 'view', 'edit')),
  PRIMARY KEY (role_id, field_id)
);

CREATE TRIGGER pipelines_updated_at BEFORE UPDATE ON pipelines FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER stages_updated_at BEFORE UPDATE ON stages FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER field_definitions_updated_at BEFORE UPDATE ON field_definitions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER products_updated_at BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION set_updated_at();
