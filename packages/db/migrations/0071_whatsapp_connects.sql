-- Connecting a WhatsApp number (spec 2026-10-18 §3.2) starts like a calendar's: a one-time nonce for the relay's
-- hand-back, kept in oauth_connects with its own kind.
ALTER TABLE oauth_connects DROP CONSTRAINT oauth_connects_kind;
ALTER TABLE oauth_connects ADD CONSTRAINT oauth_connects_kind CHECK (kind IN ('sheet', 'calendar', 'whatsapp'));
