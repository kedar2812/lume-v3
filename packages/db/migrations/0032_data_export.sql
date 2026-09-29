-- Licensing L-A (spec 2026-09-30 §3.6): "Export all data". Existing installs' admins (roles that change
-- settings) get it now; new installs through the Admin preset. The boot sync keeps the permission's words.
INSERT INTO permissions (key, "group", label, description, supports_scope, retired)
VALUES ('data.export', 'Admin', 'Export all data', 'Download everything LUME holds, unmasked, in any licence state', false, false)
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key, scope)
SELECT role_id, 'data.export', NULL FROM role_permissions WHERE permission_key = 'settings.manage'
ON CONFLICT DO NOTHING;
