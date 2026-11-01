-- WhatsApp, live (2026-11-01): a lead's chat shows a new message, and its ticks, as they happen, and the lead's owner sees
-- a notice for each message in. Said on lume_whatsapp as the lead, what happened and (for a message in) whose lead it is.
-- Never words or numbers: each screen reads what it may see under its own access. The owner is read as whoever wrote
-- the row (leads' row-level security is forced): the inbound step reads the lead itself, so it's there for a message in.
-- Identical notices in one transaction are said once, so a history import says each lead once.
CREATE FUNCTION lume_whatsapp_activity_notify() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.type = 'whatsapp_received' THEN
    PERFORM pg_notify('lume_whatsapp', json_build_object(
      'lead', NEW.lead_id, 'kind', 'in', 'owner', (SELECT owner_id FROM leads WHERE id = NEW.lead_id))::text);
  ELSIF NEW.type = 'whatsapp_sent' THEN
    PERFORM pg_notify('lume_whatsapp', json_build_object('lead', NEW.lead_id, 'kind', 'out')::text);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER activities_whatsapp_live AFTER INSERT ON activities
  FOR EACH ROW WHEN (NEW.type IN ('whatsapp_received', 'whatsapp_sent'))
  EXECUTE FUNCTION lume_whatsapp_activity_notify();

-- A message from LUME moving through the queue (sending, sent, delivered, read, failed): its ticks, live.
CREATE FUNCTION lume_whatsapp_outbox_notify() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_notify('lume_whatsapp', json_build_object('lead', NEW.lead_id, 'kind', 'status')::text);
  RETURN NEW;
END $$;
CREATE TRIGGER whatsapp_outbox_live_insert AFTER INSERT ON whatsapp_outbox
  FOR EACH ROW EXECUTE FUNCTION lume_whatsapp_outbox_notify();
CREATE TRIGGER whatsapp_outbox_live_status AFTER UPDATE OF status ON whatsapp_outbox
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION lume_whatsapp_outbox_notify();
