import type { AnnouncementClaim } from "@lume/core";
import type pg from "pg";

/**
 * The announcements live now for one client (spec 2026-10-16 fleet §2.3): started, not ended, not withdrawn, for all
 * clients or chosen for this one — newest first, at most three, as the signed answer carries them.
 */
export async function liveAnnouncements(
  db: pg.Pool | pg.PoolClient,
  clientId: string,
  now: Date,
): Promise<AnnouncementClaim[]> {
  const { rows } = await db.query<{
    id: string;
    title: string;
    body: string;
    kind: AnnouncementClaim["kind"];
    audience: AnnouncementClaim["audience"];
    window_start: Date | null;
    window_end: Date | null;
    ends_at: Date;
  }>(
    `SELECT a.id, a.title, a.body, a.kind, a.audience, a.window_start, a.window_end, a.ends_at
       FROM announcements a
      WHERE a.withdrawn_at IS NULL AND a.starts_at <= $2 AND a.ends_at > $2
        AND (a.all_clients OR EXISTS (SELECT 1 FROM announcement_clients ac
                                       WHERE ac.announcement_id = a.id AND ac.client_id = $1))
      ORDER BY a.starts_at DESC, a.created_at DESC
      LIMIT 3`,
    [clientId, now],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    kind: r.kind,
    audience: r.audience,
    windowStart: r.window_start?.toISOString() ?? null,
    windowEnd: r.window_end?.toISOString() ?? null,
    endsAt: r.ends_at.toISOString(),
  }));
}

/** What a client's LUME said of Got it, kept for its own announcements only (fleet §1.2): a count, never who. */
export async function recordSeen(
  db: pg.Pool | pg.PoolClient,
  clientId: string,
  seen: { id: string; people: number }[],
  now: Date,
): Promise<void> {
  for (const s of seen)
    await db.query(
      `INSERT INTO announcement_seen (announcement_id, client_id, people, at)
       SELECT a.id, $2, $3, $4 FROM announcements a
        WHERE a.id = $1 AND (a.all_clients OR EXISTS (SELECT 1 FROM announcement_clients ac
                                                       WHERE ac.announcement_id = a.id AND ac.client_id = $2))
       ON CONFLICT (announcement_id, client_id) DO UPDATE SET people = EXCLUDED.people, at = EXCLUDED.at`,
      [s.id, clientId, s.people, now],
    );
}
