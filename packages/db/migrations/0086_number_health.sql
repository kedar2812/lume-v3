-- The number's quality and Meta's messaging tier (Autopilot A2; spec 2026-10-19 §6): read from Meta every day (hourly
-- while a LUME AI run uses the number) and from its webhook. A drop to yellow or red pauses every run on the number.
ALTER TABLE whatsapp_numbers ADD COLUMN quality text CHECK (quality IN ('green', 'yellow', 'red'));
-- Meta's own tier name ("TIER_1K"), turned into people a day by core's tierLimitOf.
ALTER TABLE whatsapp_numbers ADD COLUMN messaging_tier text CHECK (messaging_tier ~ '^TIER_[A-Z0-9]+$');
ALTER TABLE whatsapp_numbers ADD COLUMN health_at timestamptz;
