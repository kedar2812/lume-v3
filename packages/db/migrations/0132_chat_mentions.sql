-- Team Chat 2B, mentions and their notices (plan 2026-11-25-team-chat-2b, Task 2). Who a message names is kept as rows
-- when it is sent, so telling them, "mentions me" and every count never read words again.

CREATE TABLE chat_mentions (
  message_id bigint  NOT NULL REFERENCES chat_messages (id) ON DELETE CASCADE,
  user_id    uuid    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- By their own name; else through their team or the whole channel (which a muted conversation keeps quiet).
  by_name    boolean NOT NULL,
  -- Where it was said: the conversation, and the thread in it (0: none).
  conversation_id uuid    NOT NULL REFERENCES chat_conversations (id) ON DELETE CASCADE,
  root            bigint  NOT NULL DEFAULT 0,
  -- They have looked there since: apart from how far they have read, as an edit may name someone who read it before.
  seen            boolean NOT NULL DEFAULT false,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX chat_mentions_mine ON chat_mentions (user_id, message_id DESC);
CREATE INDEX chat_mentions_unseen ON chat_mentions (user_id, conversation_id, root, message_id) WHERE NOT seen;
CREATE INDEX chat_mentions_conversation ON chat_mentions (conversation_id);

ALTER TABLE chat_mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_mentions FORCE ROW LEVEL SECURITY;
-- Seen with the message; written by its author alone.
CREATE POLICY chat_mentions_seen ON chat_mentions FOR SELECT
  USING (EXISTS (SELECT 1 FROM chat_messages m WHERE m.id = message_id));
CREATE POLICY chat_mentions_say ON chat_mentions FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM chat_messages m WHERE m.id = message_id AND m.author_id = lume_user()
                      AND m.conversation_id = chat_mentions.conversation_id));
-- Its author may name someone by name after all; whom it names says they have seen it.
CREATE POLICY chat_mentions_again ON chat_mentions FOR UPDATE
  USING (user_id = lume_user() OR EXISTS (
    SELECT 1 FROM chat_messages m WHERE m.id = message_id AND m.author_id = lume_user()))
  WITH CHECK (true);
CREATE POLICY backup_read ON chat_mentions FOR SELECT TO lume_readonly_backup USING (true);
REVOKE ALL ON chat_mentions FROM lume_worker;
REVOKE UPDATE, DELETE ON chat_mentions FROM lume_app;
GRANT UPDATE (by_name, seen) ON chat_mentions TO lume_app;

-- Named, by name, in a lead's thread or in a thread: it is theirs to follow from this message on.
CREATE FUNCTION lume_chat_mentioned() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  m record;
BEGIN
  IF NOT NEW.by_name THEN
    RETURN NULL;
  END IF;
  SELECT x.conversation_id, x.thread_root, c.kind INTO m
  FROM chat_messages x JOIN chat_conversations c ON c.id = x.conversation_id WHERE x.id = NEW.message_id;
  IF m.kind = 'lead' THEN
    INSERT INTO chat_members (conversation_id, user_id, via, last_read_id, last_delivered_id)
    VALUES (m.conversation_id, NEW.user_id, 'lead', NEW.message_id - 1, NEW.message_id - 1) ON CONFLICT DO NOTHING;
  END IF;
  IF m.thread_root IS NOT NULL THEN
    INSERT INTO chat_thread_places AS p (root_id, user_id, last_read_id, last_reply_id)
    SELECT m.thread_root, NEW.user_id, NEW.message_id - 1, t.last_reply_id FROM chat_threads t WHERE t.root_id = m.thread_root
    ON CONFLICT (root_id, user_id) DO UPDATE SET
      following = true,
      last_read_id = greatest(p.last_read_id, EXCLUDED.last_read_id),
      last_reply_id = greatest(p.last_reply_id, EXCLUDED.last_reply_id)
    WHERE NOT p.following;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION lume_chat_mentioned() FROM PUBLIC;
CREATE TRIGGER chat_mentioned AFTER INSERT OR UPDATE OF by_name ON chat_mentions FOR EACH ROW EXECUTE FUNCTION lume_chat_mentioned();

-- A notice about a conversation (or a thread in it): one unread for each kind, made anew as more comes.
ALTER TABLE notifications
  ADD COLUMN conversation_id uuid REFERENCES chat_conversations (id) ON DELETE CASCADE,
  -- The thread's first message; 0: the conversation itself.
  ADD COLUMN chat_root bigint NOT NULL DEFAULT 0,
  -- The newest message it speaks of: read up to here, it is read.
  ADD COLUMN chat_message_id bigint;
CREATE UNIQUE INDEX notifications_chat ON notifications (user_id, conversation_id, kind, chat_root)
  WHERE conversation_id IS NOT NULL AND read_at IS NULL;
CREATE INDEX notifications_conversation ON notifications (conversation_id) WHERE conversation_id IS NOT NULL;
