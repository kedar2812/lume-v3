-- LUME AI on Instagram (plan 2026-11-27-instagram-lume-ai): a run has a channel. A WhatsApp run is as it was (its
-- number); an Instagram run belongs to one connected account and only ever answers, inside Instagram's window.
ALTER TABLE autopilot_runs
  ADD COLUMN channel text NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'instagram')),
  ADD COLUMN instagram_account_id uuid REFERENCES instagram_accounts (id),
  -- The account's standing run, "New DMs on @account": one each, made on first need.
  ADD COLUMN standing boolean NOT NULL DEFAULT false,
  ALTER COLUMN number_id DROP NOT NULL,
  ADD CONSTRAINT autopilot_runs_channel_target CHECK (
    (channel = 'whatsapp' AND number_id IS NOT NULL) OR (channel = 'instagram' AND instagram_account_id IS NOT NULL)
  );
CREATE UNIQUE INDEX autopilot_runs_standing ON autopilot_runs (instagram_account_id) WHERE standing AND status <> 'ended';

-- A lead's own goal (a flow's Hand to LUME AI step), over its run's.
ALTER TABLE autopilot_leads ADD COLUMN goal jsonb;

-- Who answers a new DM no flow claims: the team (the default) or LUME AI.
ALTER TABLE instagram_accounts ADD COLUMN new_dms text NOT NULL DEFAULT 'team' CHECK (new_dms IN ('team', 'ai'));

-- An Instagram message LUME AI wrote, in this run (as WhatsApp's carry their run); its one apology for a stop is the
-- only message that may go to a lead in do not contact.
ALTER TABLE instagram_outbox
  ADD COLUMN autopilot_run_id uuid,
  ADD COLUMN allow_after_dnc boolean NOT NULL DEFAULT false;
