-- Do not contact (Autopilot spec 2026-10-19 §1.3, §3: "Stop means stop"): a lead who asked not to be messaged is held
-- by every way LUME sends, whoever sends, until an admin lifts it. Set by a person, or by LUME AI (dnc_by null) when a
-- lead says stop in a run.
ALTER TABLE leads ADD COLUMN dnc_at timestamptz;
ALTER TABLE leads ADD COLUMN dnc_by uuid REFERENCES users (id);
ALTER TABLE leads ADD COLUMN dnc_reason text CHECK (dnc_reason IS NULL OR char_length(dnc_reason) <= 200);

-- The one message a stop allows: LUME AI's short apology, queued as the lead is marked.
ALTER TABLE whatsapp_outbox ADD COLUMN allow_after_dnc boolean NOT NULL DEFAULT false;
