-- pg-boss schema is installed (and queues created) by lume_owner in the migrate step, before migrations run.
GRANT USAGE ON SCHEMA pgboss TO lume_app, lume_worker, lume_readonly_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO lume_app, lume_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO lume_app, lume_worker;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO lume_app, lume_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA pgboss TO lume_readonly_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE lume_owner IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lume_app, lume_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE lume_owner IN SCHEMA pgboss
  GRANT SELECT ON TABLES TO lume_readonly_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE lume_owner IN SCHEMA pgboss
  GRANT USAGE, SELECT ON SEQUENCES TO lume_app, lume_worker;
