-- Phase 4A (plan 2026-09-29-phase-4a): WhatsApp templates with their history, when a lead was last
-- messaged and last replied, and where a stage sends a lead after a message or a reply.
-- Templates are configuration (like stages): no lead data, so no row-level security.
CREATE TABLE message_templates (
  id                 uuid        PRIMARY KEY,
  name               citext      NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  category           text        NOT NULL
                     CHECK (category IN ('first_touch', 'follow_up', 'reminder', 're_engagement', 'custom')),
  allowed_role_ids   uuid[]      NOT NULL DEFAULT '{}',
  current_version_id uuid,
  position           integer     NOT NULL DEFAULT 0,
  created_by         uuid        REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  archived_at        timestamptz
);
CREATE UNIQUE INDEX message_templates_live_name ON message_templates (name) WHERE archived_at IS NULL;

-- Each edit is a new version; a send records the one it used, so history never changes.
CREATE TABLE template_versions (
  id          uuid        PRIMARY KEY,
  template_id uuid        NOT NULL REFERENCES message_templates (id),
  body        text        NOT NULL CHECK (length(body) BETWEEN 1 AND 4096),
  created_by  uuid        REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX template_versions_template ON template_versions (template_id, created_at DESC);
ALTER TABLE message_templates
  ADD CONSTRAINT message_templates_current FOREIGN KEY (current_version_id) REFERENCES template_versions (id);
REVOKE UPDATE, DELETE ON template_versions FROM lume_app;
REVOKE ALL ON message_templates, template_versions FROM lume_worker;

ALTER TABLE leads ADD COLUMN last_message_at timestamptz, ADD COLUMN last_reply_at timestamptz;
CREATE INDEX leads_last_message ON leads (last_message_at) WHERE deleted_at IS NULL;
CREATE INDEX leads_last_reply ON leads (last_reply_at) WHERE deleted_at IS NULL;

ALTER TABLE stages
  ADD COLUMN after_sent_stage_id  uuid REFERENCES stages (id),
  ADD COLUMN after_reply_stage_id uuid REFERENCES stages (id);
