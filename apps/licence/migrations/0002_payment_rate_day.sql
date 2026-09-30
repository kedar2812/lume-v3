-- The day a payment's rate is from: the payment's own day when that day's rates were fetched, else the
-- last day before it that had rates (the fetch can fail). Null when no rate was known.
ALTER TABLE payments ADD COLUMN rate_day date;
UPDATE payments SET rate_day = paid_at::date WHERE rate_to_inr IS NOT NULL;
