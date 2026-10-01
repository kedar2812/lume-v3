-- The daily count behind a person's send queue (4C final review, minor): their runs, and what was sent
-- since midnight, found by index rather than read through.
CREATE INDEX send_queues_user ON send_queues (user_id);
CREATE INDEX send_queue_items_sent ON send_queue_items (done_at) WHERE status = 'sent';
