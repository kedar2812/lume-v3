-- Baseline privileges (report §12.4). Tables are created by lume_owner; these defaults make every
-- future table usable by the app and worker, readable by the backup role, and creatable by no one else.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO lume_app, lume_worker, lume_readonly_backup;

ALTER DEFAULT PRIVILEGES FOR ROLE lume_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lume_app, lume_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE lume_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO lume_app, lume_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE lume_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO lume_readonly_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE lume_owner IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO lume_readonly_backup;

GRANT SELECT ON schema_migrations TO lume_readonly_backup;
