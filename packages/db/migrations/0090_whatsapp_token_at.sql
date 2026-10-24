-- When a number's token was given or last refreshed (2026-10-24): Meta's Embedded Signup tokens last 60 days, and LUME
-- refreshes each through the relay once it's 30 days old. Null on numbers connected before this: their age counts from
-- connected_at.
ALTER TABLE whatsapp_numbers ADD COLUMN token_at timestamptz;
