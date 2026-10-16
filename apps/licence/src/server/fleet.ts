import type { FleetHealth } from "@lume/core";
import type pg from "pg";
import { z } from "zod";
import { compareVersions } from "@/lib/alerts";
import { fleetStatus, problemsOf, STATUS_RANK, type FleetStatus, type Problem } from "@/lib/fleet";
import { latestVersion, Refusal } from "./clients";
import type { Ctx } from "./context";

/**
 * Fleet on the dashboard (spec 2026-10-16 fleet §2.2–§2.4): how each live client's LUME is, from its newest check-in,
 * and announcements from LUME's team with how far each got.
 */

type Latest = {
  client_id: string;
  name: string;
  at: Date | null;
  app_version: string | null;
  active_users: number | null;
  lead_count: number | null;
  health: FleetHealth | null;
  accepts: string[] | null;
  places: number | null;
};
/** Every live client (not suspended, not decommissioned) with its newest check-in, if any. */
const LIVE_LATEST_SQL = `
  SELECT c.id AS client_id, c.name, l.places, ci.at, ci.app_version, ci.active_users, ci.lead_count, ci.health, ci.accepts
    FROM clients c
    JOIN licences l ON l.client_id = c.id
    LEFT JOIN LATERAL (SELECT at, app_version, active_users, lead_count, health, accepts FROM check_ins
                        WHERE client_id = c.id ORDER BY at DESC, id DESC LIMIT 1) ci ON true
   WHERE c.decommissioned_at IS NULL AND l.suspended_at IS NULL
   ORDER BY c.name`;
const liveLatest = async (db: pg.Pool) => (await db.query<Latest>(LIVE_LATEST_SQL)).rows;
const accepts = (r: Pick<Latest, "accepts">) => !!r.accepts?.includes("announcements");

export type FleetRow = {
  id: string;
  name: string;
  status: FleetStatus;
  problems: Problem[];
  lastCheckInAt: string;
  version: string;
  behind: boolean;
  people: number;
  places: number | null;
  leads: number;
  uptimeS: number | null;
  dbBytes: number | null;
  diskFreePct: number | null;
  errors24h: number | null;
  queue: FleetHealth["queue"] | null;
  restoreTest: FleetHealth["restoreTest"];
  acceptsAnnouncements: boolean;
};

export async function fleet(ctx: Ctx) {
  const now = ctx.now();
  const latest = await latestVersion(ctx.db);
  const rows: FleetRow[] = [];
  for (const r of await liveLatest(ctx.db)) {
    if (!r.at) continue; // never checked in: on Clients as not activated
    const lastCheckInAt = r.at.toISOString();
    const status = fleetStatus({ lastCheckInAt, health: r.health }, now)!;
    const h = r.health;
    rows.push({
      id: r.client_id,
      name: r.name,
      status,
      problems: status === "down" ? [] : problemsOf(h, now),
      lastCheckInAt,
      version: r.app_version!,
      behind: !!latest && compareVersions(r.app_version!, latest) < 0,
      people: r.active_users ?? 0,
      places: r.places,
      leads: r.lead_count ?? 0,
      uptimeS: h?.uptimeS ?? null,
      dbBytes: h?.dbBytes ?? null,
      diskFreePct: h?.diskFreePct ?? null,
      errors24h: h?.errors24h ?? null,
      queue: h?.queue ?? null,
      restoreTest: h?.restoreTest ?? null,
      acceptsAnnouncements: accepts(r),
    });
  }
  rows.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.name.localeCompare(b.name));
  const n = (s: FleetStatus) => rows.filter((r) => r.status === s).length;
  return {
    rows,
    latestVersion: latest,
    counts: {
      total: rows.length,
      online: rows.length - n("down"),
      look: n("look"),
      down: n("down"),
      none: n("none"),
      behind: rows.filter((r) => r.behind).length,
    },
  };
}

/** One client's health for its page: the newest, and one point a day (the day's last) for 14 days. */
export async function clientHealth(db: pg.Pool, clientId: string, now: Date) {
  const last = (
    await db.query<{ at: Date; health: FleetHealth | null }>(
      "SELECT at, health FROM check_ins WHERE client_id = $1 ORDER BY at DESC, id DESC LIMIT 1",
      [clientId],
    )
  ).rows[0];
  const trend = (
    await db.query<{ day: string; db_bytes: string; disk: number | null }>(
      `SELECT DISTINCT ON (date_trunc('day', at)) to_char(date_trunc('day', at), 'YYYY-MM-DD') AS day,
              health->>'dbBytes' AS db_bytes, (health->>'diskFreePct')::int AS disk
         FROM check_ins
        WHERE client_id = $1 AND health IS NOT NULL AND at >= $2::timestamptz - interval '14 days'
        ORDER BY date_trunc('day', at), at DESC, id DESC`,
      [clientId, now],
    )
  ).rows;
  const lastCheckInAt = last?.at.toISOString() ?? null;
  const status = fleetStatus({ lastCheckInAt, health: last?.health ?? null }, now);
  return {
    health: last
      ? {
          status: status!,
          problems: status === "down" ? [] : problemsOf(last.health, now),
          health: last.health,
          at: lastCheckInAt!,
        }
      : null,
    healthTrend: trend.map((p) => ({ day: p.day, dbBytes: Number(p.db_bytes), diskFreePct: p.disk })),
  };
}

// ─ Announcements ───────────────────────────────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const iso = z.iso.datetime();
// Control characters other than a new line and a tab: unreadable in LUME, and six bytes each in the signed answer.
// eslint-disable-next-line no-control-regex -- control characters are exactly what's refused
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
export const newAnnouncementSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, "Give it a title.")
      .max(80, "A title is 80 characters at most.")
      .refine((v) => !CONTROL.test(v) && !/[\n\r\t]/.test(v), "A title is one line of plain text."),
    body: z
      .string()
      .trim()
      .min(1, "Write the message.")
      .max(600, "A message is 600 characters at most.")
      .refine(
        (v) => !CONTROL.test(v),
        "A message is plain text: new lines are fine, other control characters aren't.",
      ),
    kind: z.enum(["update", "maintenance"]),
    windowStart: iso.nullable(),
    windowEnd: iso.nullable(),
    audience: z.enum(["everyone", "admins"]),
    clients: z.union([z.literal("all"), z.array(z.uuid()).max(1000)]),
    startsAt: iso.nullable(),
    endsAt: iso,
  })
  .strict();

type AnnRow = {
  id: string;
  title: string;
  body: string;
  kind: "update" | "maintenance";
  window_start: Date | null;
  window_end: Date | null;
  audience: "everyone" | "admins";
  all_clients: boolean;
  starts_at: Date;
  ends_at: Date;
  created_at: Date;
  withdrawn_at: Date | null;
  chosen: string[];
  seen_by: string;
};
const ANN_SQL = `
  SELECT a.*, coalesce((SELECT array_agg(client_id::text) FROM announcement_clients WHERE announcement_id = a.id), '{}') AS chosen,
         coalesce((SELECT sum(people) FROM announcement_seen WHERE announcement_id = a.id), 0)::text AS seen_by
    FROM announcements a`;
const ALL_ANN_SQL = ANN_SQL + " ORDER BY a.starts_at DESC, a.created_at DESC LIMIT 200";
const ONE_ANN_SQL = ANN_SQL + " WHERE a.id = $1";

type Reach = "reached" | "older" | "waiting";
function reachOf(a: AnnRow, c: Latest): Reach {
  const from = Math.max(a.starts_at.getTime(), a.created_at.getTime());
  if (c.at && c.at.getTime() >= from && accepts(c)) return "reached";
  if (c.at && !accepts(c)) return "older";
  return "waiting";
}
function stateOf(a: AnnRow, now: Date) {
  if (a.withdrawn_at) return "withdrawn" as const;
  if (a.starts_at > now) return "scheduled" as const;
  if (a.ends_at <= now) return "ended" as const;
  return "live" as const;
}
function present(a: AnnRow, live: Latest[], now: Date) {
  const audience = a.all_clients ? live : live.filter((c) => a.chosen.includes(c.client_id));
  const reaches = audience.map((c) => ({ id: c.client_id, name: c.name, reach: reachOf(a, c) }));
  const count = (r: Reach) => reaches.filter((x) => x.reach === r).length;
  const n = a.all_clients ? null : a.chosen.length;
  return {
    id: a.id,
    title: a.title,
    body: a.body,
    kind: a.kind,
    windowStart: a.window_start?.toISOString() ?? null,
    windowEnd: a.window_end?.toISOString() ?? null,
    audience: a.audience,
    allClients: a.all_clients,
    clientIds: a.chosen,
    audienceText: `${a.audience === "admins" ? "Admins" : "Everyone"} at ${
      n === null ? "all clients" : n === 1 ? "1 client" : `${n} clients`
    }`,
    startsAt: a.starts_at.toISOString(),
    endsAt: a.ends_at.toISOString(),
    createdAt: a.created_at.toISOString(),
    withdrawnAt: a.withdrawn_at?.toISOString() ?? null,
    state: stateOf(a, now),
    reach: {
      audience: audience.length,
      reached: count("reached"),
      cannot: count("older"),
      waiting: count("waiting"),
      seenBy: Number(a.seen_by),
    },
    clients: reaches,
  };
}

export async function listAnnouncements(ctx: Ctx) {
  const now = ctx.now();
  const live = await liveLatest(ctx.db);
  const { rows } = await ctx.db.query<AnnRow>(ALL_ANN_SQL);
  return { announcements: rows.map((a) => present(a, live, now)) };
}

async function one(ctx: Ctx, id: string) {
  if (!z.uuid().safeParse(id).success) throw new Refusal(404, "No such announcement.");
  const a = (await ctx.db.query<AnnRow>(ONE_ANN_SQL, [id])).rows[0];
  if (!a) throw new Refusal(404, "No such announcement.");
  return present(a, await liveLatest(ctx.db), ctx.now());
}
export const getAnnouncement = one;

/** Publish (spec fleet §3.4): checked, kept, and a line in each audience client's history. */
export async function createAnnouncement(ctx: Ctx, input: z.infer<typeof newAnnouncementSchema>) {
  const p = newAnnouncementSchema.safeParse(input);
  if (!p.success) throw new Refusal(400, p.error.issues[0]?.message ?? "That doesn't look right.");
  const b = p.data;
  const now = ctx.now();
  const starts = b.startsAt ? new Date(b.startsAt) : now;
  const ends = new Date(b.endsAt);
  if (b.kind === "maintenance" && (!b.windowStart || !b.windowEnd))
    throw new Refusal(400, "Say when the maintenance starts and ends.");
  if (b.kind === "update" && (b.windowStart || b.windowEnd))
    throw new Refusal(400, "Only maintenance has a window.");
  if (b.windowStart && b.windowEnd && Date.parse(b.windowEnd) <= Date.parse(b.windowStart))
    throw new Refusal(400, "The maintenance must end after it starts.");
  if (ends <= now) throw new Refusal(400, "It would end before anyone saw it.");
  if (ends <= starts) throw new Refusal(400, "It must end after it starts.");
  if (ends.getTime() - starts.getTime() > 60 * DAY)
    throw new Refusal(400, "An announcement shows for 60 days at most.");
  const live = await liveLatest(ctx.db);
  const chosen = b.clients === "all" ? null : [...new Set(b.clients)];
  if (chosen && (!chosen.length || chosen.some((id) => !live.some((c) => c.client_id === id))))
    throw new Refusal(400, "Choose at least one client.");

  const c = await ctx.db.connect();
  let id: string;
  try {
    await c.query("BEGIN");
    id = (
      await c.query<{ id: string }>(
        `INSERT INTO announcements (title, body, kind, window_start, window_end, audience, all_clients, starts_at, ends_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [b.title, b.body, b.kind, b.windowStart, b.windowEnd, b.audience, !chosen, starts, ends, now],
      )
    ).rows[0]!.id;
    for (const clientId of chosen ?? [])
      await c.query("INSERT INTO announcement_clients (announcement_id, client_id) VALUES ($1, $2)", [
        id,
        clientId,
      ]);
    for (const x of chosen ?? live.map((l) => l.client_id))
      await c.query("INSERT INTO events (client_id, at, kind, detail) VALUES ($1, $2, 'announcement', $3)", [
        x,
        now,
        JSON.stringify({ id, title: b.title, action: "published" }),
      ]);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  return { announcement: await one(ctx, id) };
}

/** Withdraw: gone from each LUME at its next check-in, and said in each audience client's history. */
export async function withdrawAnnouncement(ctx: Ctx, id: string) {
  const a = await one(ctx, id);
  if (a.withdrawnAt) return { announcement: a };
  const now = ctx.now();
  await ctx.db.query("UPDATE announcements SET withdrawn_at = $2 WHERE id = $1 AND withdrawn_at IS NULL", [
    id,
    now,
  ]);
  for (const x of a.clients)
    await ctx.db.query(
      "INSERT INTO events (client_id, at, kind, detail) VALUES ($1, $2, 'announcement', $3)",
      [x.id, now, JSON.stringify({ id, title: a.title, action: "withdrawn" })],
    );
  return { announcement: await one(ctx, id) };
}

/**
 * The bell's view of each live client's health (spec fleet §2.4): its problems now, and when the current run of red
 * and of amber problems began, so one that clears and comes back is a new alert even if the old one was dismissed.
 */
export async function healthForAlerts(
  db: pg.Pool,
  now: Date,
): Promise<Map<string, { problems: Problem[]; since: { red: string | null; amber: string | null } }>> {
  const out = new Map<string, { problems: Problem[]; since: { red: string | null; amber: string | null } }>();
  for (const r of await liveLatest(db)) {
    if (!r.at || now.getTime() - r.at.getTime() > DAY || !r.health) continue;
    const problems = problemsOf(r.health, now);
    if (!problems.length) continue;
    const { rows } = await db.query<{ at: Date; health: FleetHealth | null }>(
      "SELECT at, health FROM check_ins WHERE client_id = $1 AND at >= $2::timestamptz - interval '30 days' ORDER BY at DESC, id DESC",
      [r.client_id, now],
    );
    const since = (severity: Problem["severity"]) => {
      let start: string | null = null;
      for (const x of rows) {
        if (!x.health || !problemsOf(x.health, x.at).some((p) => p.severity === severity)) break;
        start = x.at.toISOString();
      }
      return start;
    };
    out.set(r.client_id, { problems, since: { red: since("red"), amber: since("amber") } });
  }
  return out;
}
