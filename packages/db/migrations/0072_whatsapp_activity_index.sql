-- A WhatsApp message is on its lead once, however it came (live, retried, or again in past chats): processing looks
-- it up by its WhatsApp id (spec 2026-10-18 §4.1).
CREATE INDEX activities_whatsapp_wamid ON activities (lead_id, (payload->>'wamid'))
  WHERE type IN ('whatsapp_received', 'whatsapp_sent');
