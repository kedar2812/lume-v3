-- Phase 4C: whoever may message leads one at a time may run a send queue over the same leads (the daily cap
-- and the re-check at send keep it safe). Existing installs get it now, at the scope each role sends at;
-- new installs through the Sales preset. The boot sync keeps the permission's words.
INSERT INTO permissions (key, "group", label, description, supports_scope, retired)
VALUES ('messages.send_queue', 'Messaging', 'Use the send queue', 'Message many leads one after another', true, false)
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key, scope)
SELECT role_id, 'messages.send_queue', scope FROM role_permissions WHERE permission_key = 'messages.send'
ON CONFLICT DO NOTHING;
