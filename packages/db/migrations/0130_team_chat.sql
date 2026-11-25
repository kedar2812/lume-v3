-- Team Chat 2A (spec 2026-11-24-team-chat-design; plan 2026-11-24-team-chat-2a, Task 1). Channels people are members
-- of (owner, 2026-11-24: a channel that isn't yours is never seen), direct messages, and a thread on each lead that
-- follows the lead's own row security. Typing and who's online are never stored.

CREATE TABLE chat_conversations (
  id              uuid        PRIMARY KEY,
  kind            text        NOT NULL CHECK (kind IN ('channel', 'direct', 'lead')),
  name            citext      CHECK (name IS NULL OR name ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  topic           text        CHECK (topic IS NULL OR char_length(topic) <= 250),
  lead_id         uuid        UNIQUE REFERENCES leads (id) ON DELETE CASCADE,
  -- A direct message's people, their ids sorted and joined: one conversation per set of people.
  direct_key      text        UNIQUE,
  created_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  last_message_id bigint,
  last_at         timestamptz,
  CHECK ((kind = 'channel') = (name IS NOT NULL)),
  CHECK ((kind = 'lead') = (lead_id IS NOT NULL)),
  CHECK ((kind = 'direct') = (direct_key IS NOT NULL)),
  CHECK (kind = 'channel' OR topic IS NULL)
);
-- A lead's thread by its last word (the newest are listed).
CREATE INDEX chat_lead_threads ON chat_conversations (last_at DESC)
  WHERE kind = 'lead' AND last_message_id IS NOT NULL;
CREATE UNIQUE INDEX chat_channel_name ON chat_conversations (name) WHERE kind = 'channel' AND archived_at IS NULL;

-- Who is in a conversation, and where each person has read and received up to. For a lead thread a row is only where
-- the person has read to (who may read it is who may see the lead). `via`: added by hand, following a lead's thread, or kept in by a group.
CREATE TABLE chat_members (
  conversation_id   uuid        NOT NULL REFERENCES chat_conversations (id) ON DELETE CASCADE,
  user_id           uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  via               text        NOT NULL DEFAULT 'person' CHECK (via IN ('person', 'group', 'lead')),
  muted             boolean     NOT NULL DEFAULT false,
  last_read_id      bigint      NOT NULL DEFAULT 0 CHECK (last_read_id >= 0),
  last_delivered_id bigint      NOT NULL DEFAULT 0 CHECK (last_delivered_id >= 0),
  joined_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
-- A person's places: their lead threads (there may be thousands) apart from the rest; and who the groups keep in.
CREATE INDEX chat_members_user ON chat_members (user_id, via);
CREATE INDEX chat_members_groups ON chat_members (conversation_id) WHERE via = 'group';

CREATE TABLE chat_messages (
  id              bigserial   PRIMARY KEY,
  conversation_id uuid        NOT NULL REFERENCES chat_conversations (id) ON DELETE CASCADE,
  -- Null: LUME wrote it (a handoff note, 2C).
  author_id       uuid        REFERENCES users (id) ON DELETE SET NULL,
  kind            text        NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'system')),
  body            text        CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 4000),
  reply_to        bigint      REFERENCES chat_messages (id) ON DELETE SET NULL,
  -- The browser's own id for a send: the same send twice is one message.
  client_id       uuid,
  edited_at       timestamptz,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, author_id, client_id)
);
CREATE INDEX chat_messages_page ON chat_messages (conversation_id, id);
-- A message answered, found when it goes (its quotes let go of it).
CREATE INDEX chat_messages_replies ON chat_messages (reply_to) WHERE reply_to IS NOT NULL;

CREATE TABLE chat_message_edits (
  message_id bigint      NOT NULL REFERENCES chat_messages (id) ON DELETE CASCADE,
  body       text        NOT NULL,
  edited_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_message_edits_message ON chat_message_edits (message_id);

CREATE TABLE chat_reactions (
  message_id bigint NOT NULL REFERENCES chat_messages (id) ON DELETE CASCADE,
  user_id    uuid   NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  emoji      text   NOT NULL CHECK (octet_length(emoji) BETWEEN 1 AND 32),
  PRIMARY KEY (message_id, user_id, emoji)
);

-- A photo or file in chat: the bytes are the file store's (whatsapp_files, by their hash), shared and counted once.
-- Held by the person who sent it until a message uses it.
CREATE TABLE chat_files (
  id          uuid        PRIMARY KEY,
  uploader_id uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  message_id  bigint      REFERENCES chat_messages (id) ON DELETE CASCADE,
  sha256      text        NOT NULL REFERENCES whatsapp_files (sha256),
  name        text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  mime        text        NOT NULL,
  kind        text        NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'document')),
  size        bigint      NOT NULL CHECK (size > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_files_message ON chat_files (message_id);
CREATE INDEX chat_files_sha ON chat_files (sha256);
CREATE INDEX chat_files_waiting ON chat_files (created_at) WHERE message_id IS NULL;
-- Each chat file holds its bytes, as every other use does: Clean up lets bytes go only when nothing points at them.
CREATE TRIGGER chat_files_file_refs
  AFTER INSERT OR DELETE OR UPDATE OF sha256 ON chat_files
  FOR EACH ROW
  EXECUTE FUNCTION lume_whatsapp_file_refs();

-- Who a channel keeps in: everyone, a team or a role (its people come and go with it). Configuration: no lead data.
CREATE TABLE chat_channel_groups (
  channel_id uuid NOT NULL REFERENCES chat_conversations (id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('everyone', 'team', 'role')),
  team_id    uuid REFERENCES teams (id) ON DELETE CASCADE,
  role_id    uuid REFERENCES roles (id) ON DELETE CASCADE,
  CHECK ((kind = 'team') = (team_id IS NOT NULL)),
  CHECK ((kind = 'role') = (role_id IS NOT NULL))
);
CREATE UNIQUE INDEX chat_channel_groups_one ON chat_channel_groups
  (channel_id, kind, coalesce(team_id, '00000000-0000-0000-0000-000000000000'), coalesce(role_id, '00000000-0000-0000-0000-000000000000'));

-- Each person's lists folded or open (owner, 2026-11-24).
CREATE TABLE chat_list_folds (
  user_id uuid    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  list    text    NOT NULL CHECK (list IN ('channels', 'direct', 'leads')),
  folded  boolean NOT NULL,
  PRIMARY KEY (user_id, list)
);

-- #general and #wins, with everyone in (made once): before row security is forced, as the migration has no person.
INSERT INTO chat_conversations (id, kind, name, topic)
SELECT gen_random_uuid(), 'channel', n, t
FROM (VALUES ('general', 'Everyone at the business'), ('wins', 'Deals won and good news')) AS v (n, t)
WHERE NOT EXISTS (SELECT 1 FROM chat_conversations c WHERE c.kind = 'channel' AND c.name = v.n);
INSERT INTO chat_channel_groups (channel_id, kind)
SELECT c.id, 'everyone' FROM chat_conversations c
WHERE c.kind = 'channel' AND c.name IN ('general', 'wins')
  AND NOT EXISTS (SELECT 1 FROM chat_channel_groups g WHERE g.channel_id = c.id);

-- ── Who may read what ─────────────────────────────────────────────────────────────────────────────────────────────
-- Conversations, members and waiting files are not forced: the owner's own functions below read them whole (who is
-- in, what a manager may choose from, what waits too long), and the rules never ask themselves. Everyone else, the app
-- included, is held to them. What people said (messages, edits, reactions) is forced.
CREATE FUNCTION lume_chat_member(conv uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM chat_members WHERE conversation_id = conv AND user_id = lume_user())
$$;

-- A conversation's members, for the live stream deciding who hears an event (ids only, nothing they said).
CREATE FUNCTION lume_chat_member_ids(conv uuid) RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(user_id), '{}') FROM chat_members WHERE conversation_id = conv
$$;
REVOKE ALL ON FUNCTION lume_chat_member_ids(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_chat_member_ids(uuid) TO lume_app;

ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;
-- A member of a channel or direct message. A lead's thread: whoever the leads table lets see that lead, and no one else
-- (a member's row there is only where they've read to, so it never outlives the lead moving away).
CREATE POLICY chat_conversations_seen ON chat_conversations FOR SELECT
  USING (CASE WHEN kind = 'lead' THEN EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id AND l.deleted_at IS NULL)
              ELSE lume_chat_member(id) END);
CREATE POLICY chat_conversations_make ON chat_conversations FOR INSERT
  WITH CHECK (lume_user() IS NOT NULL AND kind <> 'direct'
              AND (kind <> 'lead' OR EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id AND l.deleted_at IS NULL)));
CREATE POLICY chat_conversations_change ON chat_conversations FOR UPDATE
  USING (CASE WHEN kind = 'lead' THEN EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id AND l.deleted_at IS NULL)
              ELSE lume_chat_member(id) END)
  WITH CHECK (lume_user() IS NOT NULL);

-- Whether the person may read a conversation: exactly the conversation rule above.
CREATE FUNCTION lume_chat_sees(conv uuid) RETURNS boolean LANGUAGE sql STABLE
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM chat_conversations WHERE id = conv)
$$;

ALTER TABLE chat_members ENABLE ROW LEVEL SECURITY;
-- One's own place is one's own to see (first, so a list never asks of each); others' where one may read.
CREATE POLICY chat_members_seen ON chat_members FOR SELECT
  USING (user_id = lume_user() OR lume_chat_sees(conversation_id));
-- A row one makes is one's own place in a lead's thread; who is in a channel or a direct message is the functions'.
CREATE POLICY chat_members_add ON chat_members FOR INSERT WITH CHECK (
  user_id = lume_user() AND via = 'lead'
  AND EXISTS (SELECT 1 FROM chat_conversations c WHERE c.id = conversation_id AND c.kind = 'lead'));
-- Read marks and mute: only one's own row.
CREATE POLICY chat_members_own ON chat_members FOR UPDATE USING (user_id = lume_user()) WITH CHECK (user_id = lume_user());
-- Who leaves a channel is the groups' and the managers' (lume_chat_set_people): no one's own DELETE.

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY chat_messages_seen ON chat_messages FOR SELECT
  USING (EXISTS (SELECT 1 FROM chat_conversations c WHERE c.id = conversation_id));
-- A person writes as themselves, where they may read. LUME's own (no author) come in 2C, as the owner.
CREATE POLICY chat_messages_send ON chat_messages FOR INSERT
  WITH CHECK (author_id = lume_user() AND lume_chat_sees(conversation_id));
CREATE POLICY chat_messages_own ON chat_messages FOR UPDATE
  USING (author_id = lume_user() AND lume_chat_sees(conversation_id)) WITH CHECK (author_id = lume_user());

ALTER TABLE chat_message_edits ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_message_edits FORCE ROW LEVEL SECURITY;
CREATE POLICY chat_message_edits_own ON chat_message_edits
  USING (EXISTS (SELECT 1 FROM chat_messages m WHERE m.id = message_id AND m.author_id = lume_user()))
  WITH CHECK (EXISTS (SELECT 1 FROM chat_messages m WHERE m.id = message_id AND m.author_id = lume_user()));

ALTER TABLE chat_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_reactions FORCE ROW LEVEL SECURITY;
CREATE POLICY chat_reactions_seen ON chat_reactions FOR SELECT
  USING (EXISTS (SELECT 1 FROM chat_messages m WHERE m.id = message_id));
CREATE POLICY chat_reactions_own ON chat_reactions FOR INSERT
  WITH CHECK (user_id = lume_user() AND EXISTS (SELECT 1 FROM chat_messages m WHERE m.id = message_id AND m.deleted_at IS NULL));
CREATE POLICY chat_reactions_take ON chat_reactions FOR DELETE USING (user_id = lume_user());

ALTER TABLE chat_files ENABLE ROW LEVEL SECURITY;
-- One's own file waiting to be sent, or a file on a message one may read.
CREATE POLICY chat_files_seen ON chat_files FOR SELECT
  USING ((message_id IS NULL AND uploader_id = lume_user())
         OR (message_id IS NOT NULL AND EXISTS (SELECT 1 FROM chat_messages m WHERE m.id = message_id)));
CREATE POLICY chat_files_keep ON chat_files FOR INSERT WITH CHECK (uploader_id = lume_user() AND message_id IS NULL);
CREATE POLICY chat_files_use ON chat_files FOR UPDATE
  USING (uploader_id = lume_user() AND message_id IS NULL)
  WITH CHECK (uploader_id = lume_user() AND (message_id IS NULL OR EXISTS (
    SELECT 1 FROM chat_messages m WHERE m.id = message_id AND m.author_id = lume_user())));

ALTER TABLE chat_list_folds ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_list_folds FORCE ROW LEVEL SECURITY;
CREATE POLICY chat_list_folds_own ON chat_list_folds USING (user_id = lume_user()) WITH CHECK (user_id = lume_user());

-- Who a channel keeps in: the owner's functions' alone. The app never reads or writes it (a channel that isn't yours is
-- never seen, not even that it's there), so there is no rule letting it, and no grant either.
ALTER TABLE chat_channel_groups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat_channel_groups FROM lume_app;

CREATE POLICY backup_read ON chat_conversations FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON chat_members FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON chat_messages FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON chat_message_edits FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON chat_reactions FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON chat_files FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON chat_list_folds FOR SELECT TO lume_readonly_backup USING (true);
CREATE POLICY backup_read ON chat_channel_groups FOR SELECT TO lume_readonly_backup USING (true);

REVOKE ALL ON chat_conversations, chat_members, chat_messages, chat_message_edits, chat_reactions, chat_files,
  chat_channel_groups, chat_list_folds FROM lume_worker;
REVOKE ALL ON SEQUENCE chat_messages_id_seq FROM lume_worker;

-- What the app itself may change of a row: never whose it is or which conversation it's in (row-level security decides
-- which rows; a row moved somewhere else would pass it).
REVOKE UPDATE ON chat_conversations, chat_members, chat_messages, chat_message_edits, chat_reactions, chat_files FROM lume_app;
GRANT UPDATE (last_message_id, last_at) ON chat_conversations TO lume_app;
GRANT UPDATE (muted, last_read_id, last_delivered_id) ON chat_members TO lume_app;
GRANT UPDATE (body, edited_at, deleted_at) ON chat_messages TO lume_app;
GRANT UPDATE (message_id) ON chat_files TO lume_app;

-- ── Groups keep their people in ───────────────────────────────────────────────────────────────────────────────────
-- Adds active people a channel's groups match, and takes out people a group added who no longer match (or aren't
-- active). Someone added by hand stays. Run after any change to roles, teams, people or a channel's groups.
-- One at a time (the lock), so two changes at once each see the other's; answers how many rows it changed.
CREATE FUNCTION lume_chat_sync_groups() RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  added bigint;
  gone bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('lume_chat_sync'));
  -- What was said before someone joined is theirs to read, and isn't unread.
  INSERT INTO chat_members (conversation_id, user_id, via, last_read_id, last_delivered_id)
  SELECT DISTINCT g.channel_id, u.id, 'group', coalesce(c.last_message_id, 0), coalesce(c.last_message_id, 0)
  FROM chat_channel_groups g
  JOIN chat_conversations c ON c.id = g.channel_id
  JOIN users u ON u.status = 'active'
  WHERE g.kind = 'everyone'
     OR (g.kind = 'team' AND EXISTS (SELECT 1 FROM team_members t WHERE t.team_id = g.team_id AND t.user_id = u.id))
     OR (g.kind = 'role' AND EXISTS (SELECT 1 FROM user_roles r WHERE r.role_id = g.role_id AND r.user_id = u.id))
  ORDER BY 1, 2
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS added = ROW_COUNT;
  DELETE FROM chat_members m
  WHERE m.via = 'group'
    AND NOT EXISTS (
      SELECT 1 FROM chat_channel_groups g JOIN users u ON u.id = m.user_id AND u.status = 'active'
      WHERE g.channel_id = m.conversation_id
        AND (g.kind = 'everyone'
          OR (g.kind = 'team' AND EXISTS (SELECT 1 FROM team_members t WHERE t.team_id = g.team_id AND t.user_id = u.id))
          OR (g.kind = 'role' AND EXISTS (SELECT 1 FROM user_roles r WHERE r.role_id = g.role_id AND r.user_id = u.id))));
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN added + gone;
END
$$;
REVOKE ALL ON FUNCTION lume_chat_sync_groups() FROM PUBLIC;

CREATE FUNCTION lume_chat_sync_trigger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  -- As the transaction commits, once, whatever it changed: a team or a person's roles saved as "all out, the new ones
  -- in" never puts anyone out of a channel in between (they would lose where they had read to), and the lock is held
  -- for this alone.
  IF current_setting('lume.chat_synced', true) = 'on' THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('lume.chat_synced', 'on', true);
  -- Who is in which channel changed: every open stream forgets what it knew (on commit).
  IF lume_chat_sync_groups() > 0 THEN
    PERFORM pg_notify('lume_chat', '{"e":"members"}');
  END IF;
  RETURN NULL;
END
$$;

-- ── Whoever manages channels ──────────────────────────────────────────────────────────────────────────────────────
-- The owner's functions, called only by routes that check chat.channels.manage: a manager chooses who is in a channel
-- without being in it, and never reads what is said there.
CREATE FUNCTION lume_chat_set_people(conv uuid, people uuid[], groups jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('lume_chat_sync'));
  IF NOT EXISTS (SELECT 1 FROM chat_conversations WHERE id = conv AND kind = 'channel') THEN
    RAISE EXCEPTION 'not a channel' USING ERRCODE = 'no_data_found';
  END IF;
  -- In place, so nobody who stays loses where they had read to or their mute.
  UPDATE chat_members SET via = 'group' WHERE conversation_id = conv AND via = 'person' AND NOT (user_id = ANY (people));
  INSERT INTO chat_members (conversation_id, user_id, via, last_read_id, last_delivered_id)
  SELECT conv, u.id, 'person', coalesce(c.last_message_id, 0), coalesce(c.last_message_id, 0)
  FROM users u JOIN chat_conversations c ON c.id = conv
  WHERE u.id = ANY (people) AND u.status = 'active' ORDER BY u.id
  ON CONFLICT (conversation_id, user_id) DO UPDATE SET via = 'person';
  -- Only the groups that changed, the new ones first: someone moving from one to another never drops out between.
  INSERT INTO chat_channel_groups (channel_id, kind, team_id, role_id)
  SELECT conv, g ->> 'kind',
         CASE WHEN g ->> 'kind' = 'team' THEN (g ->> 'id')::uuid END,
         CASE WHEN g ->> 'kind' = 'role' THEN (g ->> 'id')::uuid END
  FROM jsonb_array_elements(groups) AS g
  ON CONFLICT DO NOTHING;
  DELETE FROM chat_channel_groups x WHERE x.channel_id = conv AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(groups) AS g
    WHERE g ->> 'kind' = x.kind
      AND (x.kind = 'everyone' OR (g ->> 'id')::uuid = coalesce(x.team_id, x.role_id)));
  -- Nothing may have fired (the same groups): whoever was taken out by hand goes now.
  PERFORM lume_chat_sync_groups();
END
$$;
CREATE FUNCTION lume_chat_change_channel(conv uuid, new_name citext, new_topic text, set_topic boolean, archive boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE chat_conversations SET
    name = coalesce(new_name, name),
    topic = CASE WHEN set_topic THEN new_topic ELSE topic END,
    archived_at = CASE WHEN archive IS NULL THEN archived_at WHEN archive THEN coalesce(archived_at, now()) END
  WHERE id = conv AND kind = 'channel';
  RETURN FOUND;
END
$$;
CREATE FUNCTION lume_chat_channels() RETURNS TABLE (
  id uuid, name citext, topic text, archived boolean, people uuid[], members bigint, groups jsonb
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.name, c.topic, c.archived_at IS NOT NULL,
    coalesce((SELECT array_agg(m.user_id) FROM chat_members m WHERE m.conversation_id = c.id AND m.via = 'person'), '{}'),
    (SELECT count(*) FROM chat_members m WHERE m.conversation_id = c.id),
    coalesce((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('kind', g.kind, 'id', coalesce(g.team_id, g.role_id))))
              FROM chat_channel_groups g
              LEFT JOIN teams t ON t.id = g.team_id LEFT JOIN roles r ON r.id = g.role_id
              -- A team or role deleted since matches nobody, and goes when the channel is next saved.
              WHERE g.channel_id = c.id AND t.deleted_at IS NULL AND r.deleted_at IS NULL), '[]')
  FROM chat_conversations c WHERE c.kind = 'channel' ORDER BY c.archived_at IS NOT NULL, c.name
$$;
-- ── A lead's owner follows its thread ─────────────────────────────────────────────────────────────────────────────
-- Their place there is made when something is said in it, and when a lead that has been talked about becomes theirs:
-- a person's list is their own places alone, however many leads and threads there are.
CREATE FUNCTION lume_chat_follow_owner(conv uuid) RETURNS void LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  INSERT INTO chat_members (conversation_id, user_id, via)
  SELECT c.id, l.owner_id, 'lead' FROM chat_conversations c JOIN leads l ON l.id = c.lead_id
  WHERE c.id = conv AND l.owner_id IS NOT NULL ON CONFLICT DO NOTHING
$$;
CREATE FUNCTION lume_chat_lead_moved() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO chat_members (conversation_id, user_id, via)
  SELECT c.id, NEW.owner_id, 'lead' FROM chat_conversations c WHERE c.lead_id = NEW.id AND c.last_message_id IS NOT NULL
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$$;
CREATE TRIGGER chat_lead_moved AFTER UPDATE OF owner_id ON leads FOR EACH ROW
  WHEN (NEW.owner_id IS NOT NULL AND OLD.owner_id IS DISTINCT FROM NEW.owner_id)
  EXECUTE FUNCTION lume_chat_lead_moved();
-- ── Who's online ──────────────────────────────────────────────────────────────────────────────────────────────────
-- Of these people (those with a stream open), the ones the asker shares a channel or direct message with.
CREATE FUNCTION lume_chat_share(people uuid[]) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT p FROM unnest(people) AS p
  WHERE p IS DISTINCT FROM lume_user() AND EXISTS (
    SELECT 1 FROM chat_members o
    JOIN chat_members m ON m.conversation_id = o.conversation_id AND m.user_id = lume_user()
    JOIN chat_conversations c ON c.id = o.conversation_id AND c.kind <> 'lead'
    WHERE o.user_id = p)
$$;
-- ── What chat keeps in the file store (Settings › Storage) ────────────────────────────────────────────────────────
CREATE FUNCTION lume_chat_file_hashes() RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$ SELECT DISTINCT sha256::text FROM chat_files $$;
-- ── A direct message ──────────────────────────────────────────────────────────────────────────────────────────────
-- The one conversation of these people, the asker always among them: made whole, or the one already there. Its id
-- comes from its people, so two starting it at once write the same row.
CREATE FUNCTION lume_chat_direct(people uuid[]) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  everyone uuid[] := ARRAY(SELECT DISTINCT p FROM unnest(people || lume_user()) AS p WHERE p IS NOT NULL ORDER BY p);
  key text := array_to_string(everyone, ',');
  h text := encode(sha256(convert_to('lume-chat-direct:' || key, 'UTF8')), 'hex');
  conv uuid := (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-8' || substr(h, 14, 3) || '-8' || substr(h, 18, 3)
                || '-' || substr(h, 21, 12))::uuid;
BEGIN
  IF lume_user() IS NULL OR cardinality(everyone) NOT BETWEEN 2 AND 8 THEN
    RAISE EXCEPTION 'a direct message is 2 to 8 people' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(everyone) AS p
             WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p AND u.status = 'active')) THEN
    RAISE EXCEPTION 'someone here is not active' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO chat_conversations (id, kind, direct_key, created_by) VALUES (conv, 'direct', key, lume_user())
  ON CONFLICT DO NOTHING;
  INSERT INTO chat_members (conversation_id, user_id) SELECT conv, p FROM unnest(everyone) AS p ON CONFLICT DO NOTHING;
  RETURN conv;
END
$$;
-- ── Files nobody sent ─────────────────────────────────────────────────────────────────────────────────────────────
-- Taken off before sending, or the tab closed: let go after a day (their bytes follow when nothing else holds them).
CREATE FUNCTION lume_chat_forget_files(before timestamptz) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM chat_files WHERE id IN (
    SELECT f.id FROM chat_files f WHERE f.message_id IS NULL AND f.created_at < before ORDER BY f.created_at LIMIT 1000
    FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION lume_chat_set_people(uuid, uuid[], jsonb),
  lume_chat_change_channel(uuid, citext, text, boolean, boolean), lume_chat_channels(), lume_chat_direct(uuid[]),
  lume_chat_forget_files(timestamptz), lume_chat_share(uuid[]), lume_chat_file_hashes(),
  lume_chat_follow_owner(uuid), lume_chat_lead_moved() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_chat_set_people(uuid, uuid[], jsonb),
  lume_chat_change_channel(uuid, citext, text, boolean, boolean), lume_chat_channels(), lume_chat_direct(uuid[]),
  lume_chat_forget_files(timestamptz), lume_chat_share(uuid[]), lume_chat_file_hashes(),
  lume_chat_follow_owner(uuid) TO lume_app;

CREATE CONSTRAINT TRIGGER chat_sync_roles AFTER INSERT OR UPDATE OR DELETE ON user_roles
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lume_chat_sync_trigger();
CREATE CONSTRAINT TRIGGER chat_sync_teams AFTER INSERT OR UPDATE OR DELETE ON team_members
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lume_chat_sync_trigger();
CREATE CONSTRAINT TRIGGER chat_sync_new_people AFTER INSERT ON users
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lume_chat_sync_trigger();
CREATE CONSTRAINT TRIGGER chat_sync_people AFTER UPDATE OF status ON users
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION lume_chat_sync_trigger();
CREATE CONSTRAINT TRIGGER chat_sync_groups AFTER INSERT OR UPDATE OR DELETE ON chat_channel_groups
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lume_chat_sync_trigger();

-- ── Permissions ───────────────────────────────────────────────────────────────────────────────────────────────────
INSERT INTO permissions (key, "group", label, description, supports_scope, retired) VALUES
  ('chat.use', 'Chat', 'Use Team Chat', 'Channels they''re in, direct messages, and lead threads', false, false),
  ('chat.channels.manage', 'Chat', 'Manage channels', 'Make, rename and archive channels, and choose who''s in them', false, false)
ON CONFLICT (key) DO NOTHING;
-- Everyone chats on existing installs; whoever manages roles manages channels.
INSERT INTO role_permissions (role_id, permission_key, scope)
SELECT id, 'chat.use', NULL FROM roles ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key, scope)
SELECT role_id, 'chat.channels.manage', NULL FROM role_permissions WHERE permission_key = 'roles.manage'
ON CONFLICT DO NOTHING;

-- Everyone into #general and #wins now (from here on the triggers keep them right).
SELECT lume_chat_sync_groups();
