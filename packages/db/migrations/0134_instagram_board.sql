-- Instagram in Analytics (plan 2026-11-25-instagram-screens D6b): a conversation is a thread started in the range,
-- and what started it is the thread's source.trigger. A story reply or mention now says so as the conversation starts
-- (process.ts); the ones before this read it from their first message, once.
SELECT set_config('lume.lead_scope', 'all', true);
UPDATE instagram_threads t
   SET source = t.source || '{"trigger": "story"}'::jsonb
 WHERE t.source = '{}'::jsonb
   AND EXISTS (
     SELECT 1 FROM activities a
      WHERE a.lead_id = t.lead_id AND a.type = 'instagram_received' AND a.payload ->> 'threadId' = t.id::text
        AND (a.payload ? 'story' OR a.payload ? 'mention')
        AND a.occurred_at = (SELECT min(b.occurred_at) FROM activities b
                              WHERE b.lead_id = t.lead_id AND b.type = 'instagram_received'
                                AND b.payload ->> 'threadId' = t.id::text));
SELECT set_config('lume.lead_scope', '', true);

-- The board's reads, each over its own slice at any volume: conversations by when they started, private replies by
-- when they went, and those who asked on Instagram to stop by when.
CREATE INDEX instagram_threads_started ON instagram_threads (created_at);
CREATE INDEX instagram_comments_private_sent ON instagram_comments (private_reply_at) WHERE private_reply = 'sent';
CREATE INDEX leads_stopped_on_instagram ON leads (dnc_at) WHERE dnc_reason = 'Said stop on Instagram';
