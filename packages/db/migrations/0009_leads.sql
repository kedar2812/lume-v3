-- Leads and activity (report §5.3, §5.6).
CREATE TABLE leads (
  id                uuid           PRIMARY KEY,
  pipeline_id       uuid           NOT NULL REFERENCES pipelines (id),
  stage_id          uuid           NOT NULL,
  owner_id          uuid           REFERENCES users (id),
  name              text           NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  phone_raw         text,
  phone_e164        text,
  phone_country_iso char(2),
  phone_status      text           NOT NULL DEFAULT 'missing' CHECK (phone_status IN ('valid', 'needs_country', 'invalid', 'missing')),
  phone_digits      text           GENERATED ALWAYS AS (regexp_replace(coalesce(phone_e164, phone_raw, ''), '\D', '', 'g')) STORED,
  email             citext,
  instagram_handle  citext,
  source_id         uuid, -- FK to lead_sources arrives with Phase 2
  external_ref      text,
  value             numeric(14, 2) CHECK (value >= 0),
  currency          char(3),
  product_id        uuid           REFERENCES products (id),
  lost_reason_id    uuid           REFERENCES lost_reasons (id),
  lost_note         text,
  won_at            timestamptz,
  lost_at           timestamptz,
  custom            jsonb          NOT NULL DEFAULT '{}'::jsonb,
  lead_created_at   date,
  last_activity_at  timestamptz,
  next_task_due_at  timestamptz,
  stage_entered_at  timestamptz    NOT NULL DEFAULT now(),
  version           integer        NOT NULL DEFAULT 1,
  created_by        uuid           REFERENCES users (id),
  created_at        timestamptz    NOT NULL DEFAULT now(),
  updated_at        timestamptz    NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  FOREIGN KEY (stage_id, pipeline_id) REFERENCES stages (id, pipeline_id)
);
CREATE INDEX leads_owner_stage ON leads (owner_id, stage_id) WHERE deleted_at IS NULL;
CREATE INDEX leads_pipeline_stage ON leads (pipeline_id, stage_id, stage_entered_at);
CREATE INDEX leads_phone ON leads (phone_e164);
CREATE INDEX leads_email ON leads (email);
CREATE INDEX leads_instagram ON leads (instagram_handle);
CREATE INDEX leads_name_trgm ON leads USING gin (name gin_trgm_ops);
CREATE INDEX leads_email_trgm ON leads USING gin ((email::text) gin_trgm_ops);
CREATE INDEX leads_phone_digits_trgm ON leads USING gin (phone_digits gin_trgm_ops);
CREATE INDEX leads_custom ON leads USING gin (custom jsonb_path_ops);
CREATE INDEX leads_updated ON leads (updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER leads_updated_at BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE lead_tags (
  lead_id uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  tag_id  uuid NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (lead_id, tag_id)
);
CREATE INDEX lead_tags_tag ON lead_tags (tag_id);

-- Insert-only: the analytics backbone (report §5.3).
CREATE TABLE lead_stage_history (
  id            bigserial   PRIMARY KEY,
  lead_id       uuid        NOT NULL REFERENCES leads (id),
  from_stage_id uuid        REFERENCES stages (id),
  to_stage_id   uuid        NOT NULL REFERENCES stages (id),
  pipeline_id   uuid        NOT NULL REFERENCES pipelines (id),
  changed_by    uuid        REFERENCES users (id),
  changed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_stage_history_funnel ON lead_stage_history (pipeline_id, to_stage_id, changed_at);
CREATE INDEX lead_stage_history_lead ON lead_stage_history (lead_id, changed_at);

CREATE TABLE lead_assignment_history (
  id           bigserial   PRIMARY KEY,
  lead_id      uuid        NOT NULL REFERENCES leads (id),
  from_user_id uuid        REFERENCES users (id),
  to_user_id   uuid        REFERENCES users (id),
  changed_by   uuid        REFERENCES users (id),
  changed_at   timestamptz NOT NULL DEFAULT now(),
  reason       text
);
CREATE INDEX lead_assignment_history_lead ON lead_assignment_history (lead_id, changed_at);

CREATE TABLE activities (
  id          uuid        PRIMARY KEY,
  lead_id     uuid        NOT NULL REFERENCES leads (id),
  user_id     uuid        REFERENCES users (id),
  type        text        NOT NULL CHECK (type ~ '^[a-z_]{2,40}$'),
  payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activities_lead ON activities (lead_id, occurred_at DESC);
CREATE INDEX activities_user ON activities (user_id, type, occurred_at);

-- Hashes of normalised contact values, for duplicate warnings across scopes (no RLS, no plaintext).
CREATE TABLE lead_contact_keys (
  lead_id  uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  kind     text NOT NULL CHECK (kind IN ('phone', 'email', 'instagram')),
  key_hash text NOT NULL,
  PRIMARY KEY (lead_id, kind)
);
CREATE INDEX lead_contact_keys_lookup ON lead_contact_keys (kind, key_hash);

CREATE FUNCTION lead_contact_key_hash(kind text, value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(kind || ':' || value, 'UTF8')), 'hex')
$$;

CREATE FUNCTION lead_contact_keys_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM lead_contact_keys WHERE lead_id = NEW.id;
  IF NEW.deleted_at IS NULL THEN
    IF NEW.phone_e164 IS NOT NULL THEN
      INSERT INTO lead_contact_keys VALUES (NEW.id, 'phone', lead_contact_key_hash('phone', NEW.phone_e164));
    END IF;
    IF NEW.email IS NOT NULL THEN
      INSERT INTO lead_contact_keys VALUES (NEW.id, 'email', lead_contact_key_hash('email', lower(NEW.email::text)));
    END IF;
    IF NEW.instagram_handle IS NOT NULL THEN
      INSERT INTO lead_contact_keys VALUES (NEW.id, 'instagram', lead_contact_key_hash('instagram', lower(NEW.instagram_handle::text)));
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER leads_contact_keys AFTER INSERT OR UPDATE OF phone_e164, email, instagram_handle, deleted_at ON leads
  FOR EACH ROW EXECUTE FUNCTION lead_contact_keys_sync();

-- Reveal metering (report §12.2): per user per hour.
CREATE TABLE reveal_counters (
  user_id uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  hour    timestamptz NOT NULL,
  count   integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, hour)
);

-- Idempotency-Key replay (report §4.4): 24 h, purged hourly by the worker.
CREATE TABLE idempotency_keys (
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key          text        NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  route        text        NOT NULL,
  request_hash text        NOT NULL,
  status       integer     NOT NULL,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_age ON idempotency_keys (created_at);

-- History is insert-only for the app; the worker has no business with lead data yet.
REVOKE UPDATE, DELETE, TRUNCATE ON lead_stage_history, lead_assignment_history, activities FROM lume_app;
REVOKE ALL ON leads, lead_tags, lead_stage_history, lead_assignment_history, activities, lead_contact_keys, reveal_counters FROM lume_worker;
REVOKE INSERT, UPDATE ON idempotency_keys FROM lume_worker;
