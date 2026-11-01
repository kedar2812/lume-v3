-- Let LUME AI carry on (live test 2026-11-01): a lead it handed over went Ready again on the same words, round and round.
-- carried_on_at: when a person last sent LUME AI back to the lead; until the lead writes again, LUME AI answers them.
-- goal_entry_at: the lead's entry into the goal stage that already made it Ready; the same entry never does again.
ALTER TABLE autopilot_leads ADD COLUMN carried_on_at timestamptz, ADD COLUMN goal_entry_at timestamptz;
