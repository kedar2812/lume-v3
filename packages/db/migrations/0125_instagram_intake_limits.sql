-- What a stranger on Instagram can make LUME do, bounded (security review 2026-11-23): so many new leads an hour per
-- account (past that, new people wait in Not a lead yet for a person to decide), so many megabytes of files a day per
-- person and per account (past that, a file says so and isn't fetched). Each account's own numbers (the accounts
-- API; a Settings control comes with the Instagram screens); these are the defaults (packages/core INSTAGRAM_INTAKE).
ALTER TABLE instagram_accounts
  ADD COLUMN new_leads_per_hour integer NOT NULL DEFAULT 1000 CHECK (new_leads_per_hour BETWEEN 1 AND 100000),
  ADD COLUMN media_mb_per_person_day integer NOT NULL DEFAULT 200
    CHECK (media_mb_per_person_day BETWEEN 1 AND 10000),
  ADD COLUMN media_mb_per_day integer NOT NULL DEFAULT 5000 CHECK (media_mb_per_day BETWEEN 1 AND 1000000);

-- A file counts against those limits once, however many times its fetch is tried (a full disk, Meta down).
ALTER TABLE instagram_media ADD COLUMN counted boolean NOT NULL DEFAULT false;
ALTER TABLE instagram_media DROP CONSTRAINT instagram_media_status_check;
ALTER TABLE instagram_media ADD CONSTRAINT instagram_media_status_check
  CHECK (status IN ('waiting', 'ready', 'too_large', 'failed', 'gone', 'over_limit'));

-- The counts behind those limits: one row per (what, window), raised in the same transaction as the work it counts,
-- and only while under the limit, so two deliveries at once can't both slip past it. Bookkeeping: no lead data, never
-- read by a route; the hourly sweep drops windows two days old.
CREATE TABLE instagram_budgets (
  key text NOT NULL CHECK (char_length(key) <= 100),
  window_start timestamptz NOT NULL,
  used bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (key, window_start)
);
CREATE INDEX instagram_budgets_window ON instagram_budgets (window_start);
REVOKE ALL ON instagram_budgets FROM lume_worker;

-- Comments that never became a conversation are kept a while for flows (Meta re-sends for up to 36 hours), then swept.
CREATE INDEX instagram_comments_unthreaded ON instagram_comments (created_at) WHERE thread_id IS NULL;

-- Live updates carry whose lead each message is on, every kind (in, out, a tick), so each open stream tells only the
-- people who may see that lead (security review 2026-11-23); before, only "in" said whose, and every stream heard of
-- every lead. Never words: still just ids and a kind.
CREATE OR REPLACE FUNCTION lume_whatsapp_activity_notify() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.type = 'whatsapp_received' THEN
    PERFORM pg_notify('lume_whatsapp', json_build_object(
      'lead', NEW.lead_id, 'kind', 'in', 'owner', (SELECT owner_id FROM leads WHERE id = NEW.lead_id))::text);
  ELSIF NEW.type = 'whatsapp_sent' THEN
    PERFORM pg_notify('lume_whatsapp', json_build_object(
      'lead', NEW.lead_id, 'kind', 'out', 'owner', (SELECT owner_id FROM leads WHERE id = NEW.lead_id))::text);
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION lume_whatsapp_outbox_notify() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_notify('lume_whatsapp', json_build_object(
    'lead', NEW.lead_id, 'kind', 'status', 'owner', (SELECT owner_id FROM leads WHERE id = NEW.lead_id))::text);
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION lume_instagram_activity_notify() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_notify('lume_instagram', json_build_object(
    'lead', NEW.lead_id, 'kind', CASE WHEN NEW.type = 'instagram_received' THEN 'in' ELSE 'out' END,
    'owner', (SELECT owner_id FROM leads WHERE id = NEW.lead_id))::text);
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION lume_instagram_outbox_notify() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_notify('lume_instagram', json_build_object(
    'lead', NEW.lead_id, 'kind', 'status', 'owner', (SELECT owner_id FROM leads WHERE id = NEW.lead_id))::text);
  RETURN NEW;
END $$;

-- LUME AI's live run events too (0089): whose lead each one is on, so only people who may see it are told.
CREATE OR REPLACE FUNCTION lume_autopilot_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('lume_autopilot', json_build_object('run', NEW.run_id, 'lead', NEW.lead_id, 'kind', NEW.kind,
    'owner', (SELECT owner_id FROM leads WHERE id = NEW.lead_id))::text);
  RETURN NEW;
END $$;
