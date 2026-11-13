-- AI leads (owner's spec 2026-11-12): LUME AI's allowance per client is AI leads a calendar month on the client's
-- clock (Base 0, Pro 1,000, Max 3,000, Enterprise 10,000, or any number; null: no limit), signed to a LUME that
-- accepts plan5. ai_calls_monthly stays: for plan5 the owner's own hidden safety net (null: automatic, 30 actions an AI
-- lead), and for an older LUME its monthly allowance (7 actions an AI lead when the owner set none).
ALTER TABLE licences ADD COLUMN ai_leads_monthly integer CHECK (ai_leads_monthly BETWEEN 0 AND 10000000);

-- Top-ups in packs of 100 AI leads, for one month. A top-up from before AI leads keeps its calls (exactly one of the two).
ALTER TABLE ai_topups ALTER COLUMN calls DROP NOT NULL;
ALTER TABLE ai_topups ADD COLUMN leads integer CHECK (leads BETWEEN 1 AND 10000000);
ALTER TABLE ai_topups ADD CONSTRAINT ai_topups_one_unit CHECK ((calls IS NULL) <> (leads IS NULL));

-- Existing licences move to the new unit without anyone's current month starting again: a monthly number becomes AI
-- leads, about 7 actions each, up to the next 100 (at least 100), so an older LUME is never signed less than it had;
-- its safety net is then automatic. A licence with no monthly number keeps no limit. Top-ups already added stay.
-- move:start
UPDATE licences
   SET ai_leads_monthly = greatest(100, ceil(ai_calls_monthly / 7.0 / 100) * 100),
       ai_calls_monthly = NULL
 WHERE ai_calls_monthly IS NOT NULL AND ai_leads_monthly IS NULL;
-- move:end
