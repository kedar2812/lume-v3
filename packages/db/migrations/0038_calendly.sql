-- Phase 5B (spec 2026-10-01-phase-5-calendar §3): Calendly is a lead source (its bookings arrive as a
-- webhook's posts do), and each pipeline may name the stage a booked lead moves to.
ALTER TABLE lead_sources DROP CONSTRAINT lead_sources_type;
ALTER TABLE lead_sources ADD CONSTRAINT lead_sources_type
  CHECK (type IN ('csv', 'google_sheet', 'webhook', 'manual', 'calendly'));
ALTER TABLE pipelines ADD COLUMN booking_stage_id uuid REFERENCES stages (id) ON DELETE SET NULL;
