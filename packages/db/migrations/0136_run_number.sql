-- Which number a run sends from (spec 2026-11-26-run-number-choice): a focus run keeps the number chosen at its start
-- (null: a run from before, which goes from each lead owner's number as it did).
ALTER TABLE send_queues ADD COLUMN number_id uuid;
-- A run that asked (every run from now on): one without a number opens WhatsApp, never a number nobody chose. Runs
-- from before keep their old way (the lead owner's number).
ALTER TABLE send_queues ADD COLUMN number_asked boolean NOT NULL DEFAULT false;

-- Leads → More filters → Messaged from: the leads a number sent a WhatsApp message to, one indexed probe per lead.
CREATE INDEX activities_wa_sent_number ON activities ((payload ->> 'numberId'), lead_id) WHERE type = 'whatsapp_sent';
