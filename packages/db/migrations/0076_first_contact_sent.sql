-- Replying from LUME (plan W3a): a message LUME sent and Meta took is a contact too. A team that only replies from
-- LUME never opens WhatsApp, so its first contact (and speed to lead) would never start. For tap-to-send nothing
-- changes: "Yes, sent" always follows the opening, and the first contact is the earliest of them.
DROP TRIGGER activities_first_touch ON activities;
CREATE TRIGGER activities_first_touch AFTER INSERT ON activities FOR EACH ROW
  WHEN (NEW.type IN ('whatsapp_opened', 'whatsapp_confirmed_sent', 'call_logged', 'meeting_booked', 'reply_logged'))
  EXECUTE FUNCTION lume_first_touch();
