-- WhatsApp W3b-2 (plan 2026-10-19-whatsapp-templates): a LUME template sent to WhatsApp for approval, so it can reach a
-- lead outside the 24 hours. One row per template version, WhatsApp business account and language: the version that
-- was approved keeps sending as approved, and an edit is a new version that needs its own approval.
-- Configuration (like templates): no lead data, so no row-level security; written only through templates.manage routes.
CREATE TABLE whatsapp_template_submissions (
  id                  uuid        PRIMARY KEY,
  template_version_id uuid        NOT NULL REFERENCES template_versions (id),
  waba_id             text        NOT NULL,
  language            text        NOT NULL,
  category            text        NOT NULL CHECK (category IN ('MARKETING', 'UTILITY')),
  meta_name           text        NOT NULL,
  meta_template_id    text,
  -- A file at the top (W3b-1's library), uploaded to WhatsApp as the sample it reviews.
  header_file_id      uuid        REFERENCES message_files (id),
  -- LUME's variables in the order of WhatsApp's numbers: {{1}} is tokens[0].
  tokens              jsonb       NOT NULL DEFAULT '[]',
  status              text        NOT NULL
    CHECK (status IN ('submitting', 'pending', 'approved', 'rejected', 'paused', 'disabled', 'failed')),
  reason              text,
  submitted_by        uuid        REFERENCES users (id),
  submitted_at        timestamptz NOT NULL DEFAULT now(),
  decided_at          timestamptz,
  UNIQUE (template_version_id, waba_id, language)
);
-- The sweep asks WhatsApp about anything still waiting.
CREATE INDEX whatsapp_template_submissions_pending ON whatsapp_template_submissions (status) WHERE status = 'pending';
CREATE INDEX whatsapp_template_submissions_meta ON whatsapp_template_submissions (meta_template_id);

-- A message from LUME may be an approved template with this lead's values, instead of words or a file. What WhatsApp
-- charges for it is kept as shown when it was sent ("about"), and whether it counts against the monthly limit.
ALTER TABLE whatsapp_outbox
  ADD COLUMN submission_id uuid REFERENCES whatsapp_template_submissions (id),
  ADD COLUMN params jsonb,
  ADD COLUMN cost numeric(10, 4),
  ADD COLUMN cost_currency char(3),
  ADD COLUMN paid boolean NOT NULL DEFAULT false;
ALTER TABLE whatsapp_outbox DROP CONSTRAINT whatsapp_outbox_check;
ALTER TABLE whatsapp_outbox
  ADD CONSTRAINT whatsapp_outbox_content
  CHECK (text IS NOT NULL OR media_id IS NOT NULL OR submission_id IS NOT NULL OR status = 'failed');
-- This month's paid messages, counted on every send that would pass the limit.
CREATE INDEX whatsapp_outbox_paid ON whatsapp_outbox (created_at) WHERE paid;

-- The lead turned off marketing messages from this business on WhatsApp (Meta's refusal 131050): no marketing
-- template is offered for them again.
ALTER TABLE leads ADD COLUMN whatsapp_marketing_off_at timestamptz;

REVOKE ALL ON whatsapp_template_submissions FROM lume_worker;
