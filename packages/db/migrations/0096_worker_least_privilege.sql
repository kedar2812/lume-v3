-- Review 2026-10-26 D6: lume_worker (the worker container: retention, backups, the restore test) had every table the
-- default privileges gave it, so it could read and change leads, people, exports, security alerts and LUME AI's runs it
-- never touches. From here it has exactly what its jobs use, column by column where a job only filters by age, and a
-- table made later gives it nothing until a migration says so. The API's background jobs run as lume_app, not this.
-- The app never deletes an export either: an export is kept and only expires.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM lume_worker', t);
  END LOOP;
END $$;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM lume_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE lume_owner IN SCHEMA public REVOKE ALL ON TABLES FROM lume_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE lume_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM lume_worker;

-- Retention (maintenance.ts): each clears by age, reading only what it filters on.
GRANT SELECT (created_at), DELETE ON idempotency_keys TO lume_worker;
GRANT SELECT (id, source_id, status, kind, created_at, finished_at, purged_at), UPDATE (file_enc, purged_at), DELETE
  ON imports TO lume_worker;
GRANT SELECT (import_id), UPDATE (raw_enc) ON import_rows TO lume_worker;
GRANT SELECT (id), DELETE ON lead_sources TO lume_worker;
GRANT SELECT (id, requested_at), DELETE ON source_syncs TO lume_worker;
GRANT SELECT (id, created_at), DELETE ON source_refreshes TO lume_worker;
GRANT SELECT (id, created_at), DELETE ON oauth_connects TO lume_worker;
GRANT SELECT (id, status, processed_at, purged_at, received_at), UPDATE (payload_enc, purged_at), DELETE
  ON webhook_events TO lume_worker;
GRANT SELECT (id, read_at, created_at), DELETE ON notifications TO lume_worker;
GRANT SELECT (id, at), DELETE ON autopilot_events TO lume_worker;

-- Recording what its jobs did (0093), and the restore test's result.
GRANT SELECT (at), INSERT, DELETE ON ops_events TO lume_worker;
GRANT USAGE ON SEQUENCE ops_events_id_seq TO lume_worker;
GRANT INSERT ON ops_restore_tests TO lume_worker;
GRANT USAGE ON SEQUENCE ops_restore_tests_id_seq TO lume_worker;

-- The WhatsApp files backup (files-offsite.ts): the salt that names files off-site, and the files gone since.
GRANT SELECT (id, files_salt) ON settings TO lume_worker;
GRANT SELECT (sha256, gone_at), DELETE ON whatsapp_files_gone TO lume_worker;

REVOKE DELETE ON lead_exports FROM lume_app;
