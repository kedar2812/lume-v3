-- Plan tiers (Plans and pricing, November 2026): Base (no LUME AI), Pro (Autopilot first messages and follow-ups,
-- next steps, catch-ups), Max (and Autopilot replies, Ask me), Enterprise. Signed to a LUME that accepts plan6, which
-- switches on only what its tier has. Null: no tier, nothing locked (every client until the owner sets one).
ALTER TABLE licences ADD COLUMN tier text CHECK (tier IN ('base', 'pro', 'max', 'enterprise'));
