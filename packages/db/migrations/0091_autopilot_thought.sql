-- Autopilot's live view (A3, spec 2026-10-19 §2): "what LUME AI is thinking", one line, for the lead it's working. Its
-- own reason from the model (or LUME's plain words when there was no choice to make), never made up; cleared once the
-- message is sent or the lead leaves LUME AI.
ALTER TABLE autopilot_leads ADD COLUMN thought text CHECK (char_length(thought) <= 200);
