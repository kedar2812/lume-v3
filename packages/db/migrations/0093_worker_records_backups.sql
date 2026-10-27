-- The WhatsApp files backup (2026-10-19, migration 0074) records each run as the worker ('backup.files'), but 0025 kept
-- INSERT on ops_events from lume_worker: every run failed with "permission denied for table ops_events" and System
-- health said the files never reached the backup (found on a live server, 2026-10-27). The worker may now add a record;
-- it still can't change one (UPDATE stays revoked), and only removes ones past 30 days as before.
GRANT INSERT ON ops_events TO lume_worker;
GRANT USAGE ON SEQUENCE ops_events_id_seq TO lume_worker;
