-- Phase 7B (spec 2026-10-03-phase-7-scale-design §7B): every bulk action is a run. A run holds what was asked
-- (the action, and the selection in words: picked ids or a filter, never the ids themselves) and its counts; each
-- lead in it is an item holding its before-values, so a run can be resumed after a crash and undone later.
--
-- No row-level security: the API reads a run for its maker, or for someone with leads.bulk_edit at 'all', and every
-- lead an item names is read and changed as the person, under the leads' own row-level security.
CREATE TABLE bulk_runs (
  id               uuid        PRIMARY KEY,
  user_id          uuid        NOT NULL REFERENCES users (id),
  action           jsonb       NOT NULL,
  selection        jsonb       NOT NULL,
  status           text        NOT NULL DEFAULT 'queued'
                               CHECK (status IN ('queued', 'running', 'done', 'cancelled', 'failed', 'undone')),
  total            integer     NOT NULL CHECK (total >= 0),
  done             integer     NOT NULL DEFAULT 0,
  skipped          integer     NOT NULL DEFAULT 0,
  failed           integer     NOT NULL DEFAULT 0,
  skipped_by       jsonb       NOT NULL DEFAULT '{}',
  cancel_requested boolean     NOT NULL DEFAULT false,
  -- How many times the queue has taken it up; past the queue's retries it ends as failed, done chunks kept.
  attempts         integer     NOT NULL DEFAULT 0,
  -- An undo is a run too; a run is undone at most once (bulk_runs_one_undo).
  undo_of          uuid        REFERENCES bulk_runs (id),
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz
);
CREATE UNIQUE INDEX bulk_runs_one_undo ON bulk_runs (undo_of) WHERE undo_of IS NOT NULL;
CREATE INDEX bulk_runs_recent ON bulk_runs (user_id, created_at DESC);
CREATE INDEX bulk_runs_all_recent ON bulk_runs (created_at DESC);
-- What the queue picks up again after a restart.
CREATE INDEX bulk_runs_open ON bulk_runs (created_at) WHERE status IN ('queued', 'running');

CREATE TABLE bulk_run_items (
  run_id        uuid    NOT NULL REFERENCES bulk_runs (id) ON DELETE CASCADE,
  -- No foreign key: a picked id is taken as asked, and one that names no lead the person can see is skipped
  -- (LEAD_NOT_FOUND) when its turn comes, as a single bulk edit does.
  lead_id       uuid    NOT NULL,
  position      integer NOT NULL,
  result        text    NOT NULL DEFAULT 'pending' CHECK (result IN ('pending', 'done', 'skipped', 'failed')),
  code          text,
  -- What the action changed, as it was just before (owner, stage, tags, deleted, phone): what undo puts back.
  before        jsonb,
  -- The lead's version just after; undo restores a lead only if it still has this version.
  after_version integer,
  PRIMARY KEY (run_id, lead_id)
);
-- The next chunk: the run's pending items in order.
CREATE INDEX bulk_run_items_pending ON bulk_run_items (run_id, position) WHERE result = 'pending';

GRANT SELECT, INSERT, UPDATE ON bulk_runs TO lume_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON bulk_run_items TO lume_app;
-- Items hold leads' before-values: the worker role, which never touches lead data, can't read them.
REVOKE ALL ON bulk_runs, bulk_run_items FROM lume_worker;
