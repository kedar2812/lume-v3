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

/** Lost this many days ago (a view such as "Lost 30+ days" wants leads lost a while back). */
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

/** As the test database's superuser: test housekeeping, outside anyone's row-level scope. */
async function asSuperuser<T>(run: (c: pg.Client) => Promise<T>): Promise<T> {
  const url = new URL(adminUrl());
  url.pathname = `/${DB}`;
  const c = new pg.Client({ connectionString: url.toString() });
  await c.connect();
  try {
    return await run(c);
  } finally {
    await c.end();
  }
}

/**
 * What's new (spec 2026-11-02) is due for this person again: nothing seen, and an account from before the release (people
 * who join on or after it never get the window, which is every seeded person).
 */
export async function whatsNewDue(email: string): Promise<void> {
  await asSuperuser((c) =>
    c.query(
      "UPDATE users SET whats_new = '{}'::jsonb, created_at = now() - interval '60 days' WHERE email = $1",
      [email],
    ),
  );
}

/** What's new seen again, so no later spec meets the window over its page (its own save can still be in flight). */
export async function whatsNewSeen(email: string, version: string): Promise<void> {
  await asSuperuser((c) =>
    c.query(
      "UPDATE users SET whats_new = jsonb_build_object('seen', $2::text, 'used', '[]'::jsonb) WHERE email = $1",
      [email, version],
    ),
  );
}

/** WhatsApp switched on or off for the business (its stories need it on), returning what it was. */
export async function whatsappSwitch(on: boolean): Promise<boolean> {
  return asSuperuser(async (c) => {
    const was = await c.query<{ on: boolean }>(
      "SELECT coalesce((integrations->'whatsapp'->>'enabled')::boolean, false) AS on FROM settings WHERE id = 1",
    );
    await c.query(
      `UPDATE settings SET integrations = jsonb_set(integrations, '{whatsapp}',
         coalesce(integrations->'whatsapp', '{}'::jsonb) || jsonb_build_object('enabled', $1::boolean)) WHERE id = 1`,
      [on],
    );
    return was.rows[0]?.on ?? false;
  });
}

/**
 * A WhatsApp number connected for What's new's own run (its chats story needs one; whatsapp.spec connects its own later
 * and must find none of ours). Returns a function that takes it away again.
 */
export async function whatsNewNumber(ownerEmail: string): Promise<() => Promise<void>> {
  const id = "0190e0c0-0000-7000-8000-00000000f00d";
  await asSuperuser((c) =>
    c.query(
      `INSERT INTO whatsapp_numbers (id, phone_number_id, waba_id, display_phone, owner_user_id, run_as, status, token_enc)
       SELECT $1, '999000111222333', '102290129340398', '+91 90000 00009', NULL, id, 'needs_attention', decode('00', 'hex')
       FROM users WHERE email = $2
       ON CONFLICT (id) DO NOTHING`,
      [id, ownerEmail],
    ),
  );
  return () =>
    asSuperuser(async (c) => void (await c.query("DELETE FROM whatsapp_numbers WHERE id = $1", [id])));
}
