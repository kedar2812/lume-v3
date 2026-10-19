-- WhatsApp W3b-2: paid WhatsApp messages a month per client (owner 2026-10-19: usage is monthly). Null: no limit.
-- Signed into the check-in answer for a LUME that accepts plan3.
ALTER TABLE licences ADD COLUMN paid_sends_monthly integer CHECK (paid_sends_monthly BETWEEN 1 AND 10000000);
