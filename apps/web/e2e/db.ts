import path from "node:path";
import pg from "pg";
import { QUEUE_NAMES } from "@lume/core";
import { adminUrl, installQueueSchema, migrate, roleUrl } from "@lume/db";

// The database name is written out in each statement below: identifiers cannot be query parameters.
const DB = "lume_e2e";

/**
 * A brand-new installation for each run: the database is dropped and created again, migrated, and given
 * the queue schema, with no users, so /setup is genuinely a first run. (Dropping is simpler and more
 * honest than truncating: nothing from a previous run can leak in, including the append-only audit log.)
 */
export async function resetE2eDatabase(repoRoot: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query("DROP DATABASE IF EXISTS lume_e2e WITH (FORCE)");
    await admin.query("CREATE DATABASE lume_e2e OWNER lume_owner");
    await admin.query("REVOKE ALL ON DATABASE lume_e2e FROM PUBLIC");
    await admin.query("GRANT CONNECT ON DATABASE lume_e2e TO lume_app, lume_worker, lume_readonly_backup");
  } finally {
    await admin.end();
  }
  const ownerUrl = roleUrl("lume_owner", DB);
  await installQueueSchema(ownerUrl, QUEUE_NAMES);
  // Explicit: this runs from a bundle, where a path relative to the module would point elsewhere.
  await migrate(ownerUrl, path.join(repoRoot, "packages/db/migrations"));
}

/** Forget today's (and any) morning email for one person, so the next digest run sends it again. */
export async function forgetDigests(email: string): Promise<void> {
  // As the test database's superuser: this is test housekeeping, outside anyone's row-level scope.
  const url = new URL(adminUrl());
  url.pathname = `/${DB}`;
  const owner = new pg.Client({ connectionString: url.toString() });
  await owner.connect();
  try {
    await owner.query("DELETE FROM digest_runs WHERE user_id = (SELECT id FROM users WHERE email = $1)", [
      email,
    ]);
  } finally {
    await owner.end();
  }
}

/** Lost this many days ago (a view such as "Lost — re-engage" wants leads lost a while back). */
export async function backdateLost(leadIds: string[], days: number): Promise<void> {
  // As the test database's superuser: test housekeeping, outside anyone's row-level scope.
  const url = new URL(adminUrl());
  url.pathname = `/${DB}`;
  const owner = new pg.Client({ connectionString: url.toString() });
  await owner.connect();
  try {
    await owner.query(
      "UPDATE leads SET lost_at = now() - make_interval(days => $2) WHERE id = ANY($1::uuid[])",
      [leadIds, days],
    );
  } finally {
    await owner.end();
  }
}

/** A meeting as the calendar specs write it (5D): what Google or Calendly would have brought. */
export type SeedMeeting = {
  leadId: string | null;
  ownerEmail: string;
  title: string;
  startsAt: Date;
  minutes?: number;
  status?: "scheduled" | "cancelled" | "completed" | "no_show" | "rescheduled";
  matchedBy?: "attendee" | "title" | "calendar" | "calendly";
  link?: string | null;
  outcomeNote?: string | null;
};

/** Meetings straight into the database: the sync and Calendly that bring them are the API's own tests'. */
export async function seedMeetings(rows: SeedMeeting[]): Promise<string[]> {
  // As the test database's superuser: test housekeeping, outside anyone's row-level scope.
  const url = new URL(adminUrl());
  url.pathname = `/${DB}`;
  const owner = new pg.Client({ connectionString: url.toString() });
  await owner.connect();
  try {
    const ids: string[] = [];
    for (const m of rows) {
      const by = m.matchedBy ?? "calendly";
      const { rows: r } = await owner.query<{ id: string }>(
        `INSERT INTO meetings (id, lead_id, owner_id, source, external_id, matched_by, title, starts_at, ends_at,
                               link, status, outcome_note)
         VALUES (gen_random_uuid(), $1, (SELECT id FROM users WHERE email = $2), $3, 'e2e-cal-' || gen_random_uuid(),
                 $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          m.leadId,
          m.ownerEmail,
          by === "calendly" ? "calendly" : "google",
          by,
          m.title,
          m.startsAt,
          new Date(m.startsAt.getTime() + (m.minutes ?? 30) * 60_000),
          m.link === undefined ? "https://meet.google.com/abc-defg-hij" : m.link,
          m.status ?? "scheduled",
          m.outcomeNote ?? null,
        ],
      );
      ids.push(r[0]!.id);
    }
    return ids;
  } finally {
    await owner.end();
  }
}

/** Every meeting the calendar specs wrote, gone: later specs (Today's pictures) never see them. */
export async function forgetSeededMeetings(): Promise<void> {
  const url = new URL(adminUrl());
  url.pathname = `/${DB}`;
  const owner = new pg.Client({ connectionString: url.toString() });
  await owner.connect();
  try {
    await owner.query("DELETE FROM meetings WHERE external_id LIKE 'e2e-cal-%'");
  } finally {
    await owner.end();
  }
}

/** Analytics' rollups for the last 35 business days, as the API's clock would have kept them (8C screens). */
export async function rollupAnalytics(): Promise<void> {
  const c = new pg.Client({ connectionString: roleUrl("lume_app", DB) });
  await c.connect();
  try {
    const tz = (
      await c.query<{ tz: string }>("SELECT coalesce(timezone, 'UTC') AS tz FROM settings WHERE id = 1")
    ).rows[0]!.tz;
    const { rows } = await c.query<{ d: string }>(
      `SELECT to_char(d, 'YYYY-MM-DD') AS d FROM generate_series((now() AT TIME ZONE $1)::date - 35, (now() AT TIME ZONE $1)::date, '1 day') d`,
      [tz],
    );
    for (const { d } of rows) {
      await c.query("SELECT lume_rollup_day($1::date, $2)", [d, tz]);
      await c.query("SELECT lume_rollup_slot_totals($1::date)", [d]);
    }
  } finally {
    await c.end();
  }
}
