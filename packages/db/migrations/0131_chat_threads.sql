-- Team Chat 2B, threads (plan 2026-11-25-team-chat-2b, Task 1). A reply in a thread hangs on a message (its root), never
-- on another reply, and is read apart from its conversation: it doesn't make the conversation unread or move it up.

ALTER TABLE chat_messages
  ADD COLUMN thread_root bigint REFERENCES chat_messages (id) ON DELETE CASCADE,
  -- A reply its writer also sent to the conversation: shown in both.
  ADD COLUMN also_sent boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT chat_messages_also_sent CHECK (NOT also_sent OR thread_root IS NOT NULL);
-- The conversation's own messages: its pages and its unread.
CREATE INDEX chat_messages_main ON chat_messages (conversation_id, id) WHERE thread_root IS NULL OR also_sent;
CREATE INDEX chat_messages_thread ON chat_messages (thread_root, id) WHERE thread_root IS NOT NULL;

-- A thread as its root shows it: how many replies (deleted ones aren't counted), the last, and its last three people.
CREATE TABLE chat_threads (
  root_id         bigint      PRIMARY KEY REFERENCES chat_messages (id) ON DELETE CASCADE,
  conversation_id uuid        NOT NULL REFERENCES chat_conversations (id) ON DELETE CASCADE,
  replies         integer     NOT NULL DEFAULT 0 CHECK (replies >= 0),
  last_reply_id   bigint      NOT NULL,
  last_at         timestamptz NOT NULL,
  faces           uuid[]      NOT NULL DEFAULT '{}' CHECK (cardinality(faces) <= 3)
);
CREATE INDEX chat_threads_conversation ON chat_threads (conversation_id);

-- Who follows a thread, and where each has read to: whoever wrote its root or a reply, until they stop. The thread's
-- last reply is kept here too, so a person's threads, newest first, are read from their own rows alone.
CREATE TABLE chat_thread_places (
  root_id       bigint  NOT NULL REFERENCES chat_messages (id) ON DELETE CASCADE,
  user_id       uuid    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  following     boolean NOT NULL DEFAULT true,
  last_read_id  bigint  NOT NULL DEFAULT 0 CHECK (last_read_id >= 0),
  last_reply_id bigint  NOT NULL DEFAULT 0 CHECK (last_reply_id >= 0),
  PRIMARY KEY (root_id, user_id)
);
CREATE INDEX chat_thread_places_mine ON chat_thread_places (user_id, last_reply_id DESC) WHERE following;
CREATE INDEX chat_thread_places_unread ON chat_thread_places (user_id, last_reply_id DESC)
  WHERE following AND last_reply_id > last_read_id;

-- A thread is seen by whoever may read its conversation; written by the triggers below alone.
ALTER TABLE chat_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_threads_seen ON chat_threads FOR SELECT
  USING (EXISTS (SELECT 1 FROM chat_conversations c WHERE c.id = conversation_id));
-- One's own place alone; everyone's is the triggers'.
ALTER TABLE chat_thread_places ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_thread_places_own ON chat_thread_places FOR SELECT USING (user_id = lume_user());
CREATE POLICY chat_thread_places_make ON chat_thread_places FOR INSERT
  WITH CHECK (user_id = lume_user() AND EXISTS (SELECT 1 FROM chat_messages m WHERE m.id = root_id AND m.thread_root IS NULL));
CREATE POLICY chat_thread_places_change ON chat_thread_places FOR UPDATE
  USING (user_id = lume_user()) WITH CHECK (user_id = lume_user());
CREATE POLICY backup_read ON chat_threads FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON chat_thread_places FOR SELECT TO lume_readonly_backup USING (true);
REVOKE ALL ON chat_threads, chat_thread_places FROM lume_worker;
REVOKE INSERT, UPDATE, DELETE ON chat_threads FROM lume_app;
REVOKE UPDATE, DELETE ON chat_thread_places FROM lume_app;
GRANT UPDATE (following, last_read_id) ON chat_thread_places TO lume_app;

-- A reply hangs on a message of its own conversation that isn't itself a reply.
CREATE FUNCTION lume_chat_reply_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM chat_messages r WHERE r.id = NEW.thread_root AND r.conversation_id = NEW.conversation_id
                 AND r.thread_root IS NULL) THEN
    RAISE EXCEPTION 'a reply hangs on a message of its own conversation' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER chat_reply_check BEFORE INSERT ON chat_messages FOR EACH ROW WHEN (NEW.thread_root IS NOT NULL)
  EXECUTE FUNCTION lume_chat_reply_check();

-- The thread as a reply lands: counted, its writer's face first, and whoever wrote the root or this reply follows it
-- (someone who stopped following follows again by replying, and not by anyone else's reply).
CREATE FUNCTION lume_chat_reply_landed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  root_author uuid := (SELECT author_id FROM chat_messages WHERE id = NEW.thread_root);
BEGIN
  INSERT INTO chat_threads AS t (root_id, conversation_id, replies, last_reply_id, last_at, faces)
  VALUES (NEW.thread_root, NEW.conversation_id, 1, NEW.id, NEW.created_at, array_remove(ARRAY[NEW.author_id], NULL))
  ON CONFLICT (root_id) DO UPDATE SET
    replies = t.replies + 1,
    last_reply_id = greatest(t.last_reply_id, NEW.id),
    last_at = greatest(t.last_at, NEW.created_at),
    faces = (array_remove(ARRAY[NEW.author_id], NULL) || array_remove(t.faces, NEW.author_id))[1:3];
  INSERT INTO chat_thread_places (root_id, user_id)
  SELECT NEW.thread_root, root_author WHERE root_author IS NOT NULL
  ON CONFLICT DO NOTHING;
  -- One's own reply is read as it's sent, and so is what came before it.
  INSERT INTO chat_thread_places AS p (root_id, user_id, last_read_id)
  SELECT NEW.thread_root, NEW.author_id, NEW.id WHERE NEW.author_id IS NOT NULL
  ON CONFLICT (root_id, user_id) DO UPDATE SET following = true, last_read_id = greatest(p.last_read_id, NEW.id);
  -- Every follower's own row knows the newest reply (one reply at a time in a conversation: the send holds it). One
  -- also sent is unread in the conversation, not here: whoever had read everything here still has.
  UPDATE chat_thread_places p SET
    last_reply_id = NEW.id,
    last_read_id = CASE WHEN NEW.also_sent AND p.last_read_id >= p.last_reply_id THEN NEW.id ELSE p.last_read_id END
  WHERE p.root_id = NEW.thread_root AND p.following AND p.last_reply_id < NEW.id;
  RETURN NULL;
END
$$;
CREATE TRIGGER chat_reply_landed AFTER INSERT ON chat_messages FOR EACH ROW WHEN (NEW.thread_root IS NOT NULL)
  EXECUTE FUNCTION lume_chat_reply_landed();

CREATE FUNCTION lume_chat_reply_deleted() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE chat_threads SET replies = greatest(replies - 1, 0) WHERE root_id = NEW.thread_root;
  -- What its message says of the last reply, and its faces, are of those still there.
  UPDATE chat_threads t SET last_reply_id = r.id, last_at = r.created_at,
    faces = ARRAY(
      SELECT f.author_id FROM (
        SELECT x.author_id, max(x.id) AS id FROM (
          SELECT m.author_id, m.id FROM chat_messages m
          WHERE m.thread_root = NEW.thread_root AND m.deleted_at IS NULL AND m.author_id IS NOT NULL
          ORDER BY m.thread_root DESC, m.id DESC LIMIT 200) x
        GROUP BY x.author_id ORDER BY 2 DESC LIMIT 3) f ORDER BY f.id DESC)
  FROM (SELECT m.id, m.created_at FROM chat_messages m
        WHERE m.thread_root = NEW.thread_root AND m.deleted_at IS NULL ORDER BY m.thread_root DESC, m.id DESC LIMIT 1) r
  WHERE t.root_id = NEW.thread_root AND (t.last_reply_id = NEW.id OR NEW.author_id = ANY (t.faces));
  RETURN NULL;
END
$$;
CREATE TRIGGER chat_reply_deleted AFTER UPDATE OF deleted_at ON chat_messages FOR EACH ROW
  WHEN (NEW.thread_root IS NOT NULL AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION lume_chat_reply_deleted();

-- A thread's followers, for the live stream telling each whether a reply counts for them (ids only).
CREATE FUNCTION lume_chat_thread_followers(root bigint) RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(user_id), '{}') FROM chat_thread_places WHERE root_id = root AND following
$$;
REVOKE ALL ON FUNCTION lume_chat_reply_check(), lume_chat_reply_landed(), lume_chat_reply_deleted(),
  lume_chat_thread_followers(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_chat_thread_followers(bigint) TO lume_app;
