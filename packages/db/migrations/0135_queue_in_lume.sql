-- The focus run inside LUME (spec 2026-11-26-focus-run-in-lume): a lead sent from LUME keeps the message it went as,
-- and a message WhatsApp refuses later (the sender's last try, or Meta's "failed" status) makes the lead Not sent in
-- its run, with WhatsApp's reason, so the run's summary and the day's count say what really went.
ALTER TABLE send_queue_items ADD COLUMN outbox_id uuid;
CREATE INDEX send_queue_items_outbox ON send_queue_items (outbox_id) WHERE outbox_id IS NOT NULL;

-- A run is its person's alone (row-level security): the update acts as the person who sent it, for this statement.
-- Refused: Not sent, with WhatsApp's reason. Refused, then confirmed after all (a send LUME couldn't be sure of), or
-- sent again from the lead's chat (the refused one cancelled): sent again, so Try again never sends it twice.
CREATE FUNCTION lume_queue_send_status() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
DECLARE
  was text := current_setting('lume.user_id', true);
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('lume.user_id', NEW.user_id::text, true);
  IF NEW.status = 'failed' THEN
    UPDATE send_queue_items
       SET status = 'not_sent', reason = coalesce(NEW.problem, 'WhatsApp didn''t take it.'), done_at = now()
     WHERE outbox_id = NEW.id AND status = 'sent';
  ELSIF NEW.status IN ('sent', 'delivered', 'read') THEN
    UPDATE send_queue_items SET status = 'sent', reason = NULL, done_at = now()
     WHERE outbox_id = NEW.id AND status = 'not_sent';
  ELSIF NEW.status = 'cancelled' THEN
    UPDATE send_queue_items SET status = 'sent', reason = 'Sent again from their chat', done_at = now()
     WHERE outbox_id = NEW.id AND status = 'not_sent';
  END IF;
  PERFORM set_config('lume.user_id', coalesce(was, ''), true);
  RETURN NULL;
END
$$;
CREATE TRIGGER whatsapp_outbox_queue_status AFTER UPDATE OF status ON whatsapp_outbox FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status AND (NEW.status = 'failed' OR OLD.status = 'failed'))
  EXECUTE FUNCTION lume_queue_send_status();
