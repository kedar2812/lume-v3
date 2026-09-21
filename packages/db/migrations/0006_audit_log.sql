-- Report §5.5 / §12.4. Every sensitive read or write leaves a trace that no one can edit.
CREATE TABLE audit_log (
  id            bigserial   PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  actor_ip      inet,
  action        text        NOT NULL,
  entity_type   text        NOT NULL,
  entity_id     text,
  diff          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  request_id    text
);
CREATE INDEX audit_log_at ON audit_log (at DESC);
CREATE INDEX audit_log_actor ON audit_log (actor_user_id, at DESC);
CREATE INDEX audit_log_entity ON audit_log (entity_type, entity_id, at DESC);

CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();

REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM lume_app, lume_worker;
GRANT INSERT, SELECT ON audit_log TO lume_app, lume_worker;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO lume_app, lume_worker;
