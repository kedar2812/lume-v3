-- The website's multi-step demo form (2026-11-11) asks two more things: what's going wrong with the visitor's leads,
-- and how many new leads they get a month. Both optional: older websites and the no-JavaScript form send neither.
ALTER TABLE enquiries
  ADD COLUMN need text CHECK (need IS NULL OR length(need) <= 300),
  ADD COLUMN volume text CHECK (volume IS NULL OR volume IN ('<50', '50-200', '200-1000', '1000+'));
