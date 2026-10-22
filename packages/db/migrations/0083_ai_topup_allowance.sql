-- Autopilot A1: a top-up asked for is "asked" only until it arrives. The month's allowance when it was asked is kept with
-- it; once the licence brings a larger one (the owner added the top-up), it's no longer asked and a busy month may ask
-- again. Null on the other notices, and on a request from before this column (taken as still asked).
ALTER TABLE ai_limit_notices ADD COLUMN allowance integer CHECK (allowance IS NULL OR allowance > 0);
