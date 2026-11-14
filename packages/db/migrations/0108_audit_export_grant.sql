-- Download the audit log (owner 2026-11-14): its own permission, so an admin chooses who may take the log away as
-- a CSV and Roles shows who can. Existing installs: every role that may read the log may download it, as the
-- download first shipped; new installs through the Admin preset. The boot sync keeps the permission's words.
INSERT INTO permissions (key, "group", label, description, supports_scope, retired)
VALUES ('audit.export', 'Security', 'Download the audit log', 'As a CSV, with the filters on screen', false, false)
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key, scope)
SELECT role_id, 'audit.export', NULL FROM role_permissions WHERE permission_key = 'audit.view'
ON CONFLICT DO NOTHING;
