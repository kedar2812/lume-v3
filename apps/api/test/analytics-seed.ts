import { randomUUID } from "node:crypto";
import type { Harness } from "./harness";

/**
 * Small builders for analytics tests (8D-1): a lead at a time, its first contact and reply, a meeting, a follow-up.
 * Each writes exactly what LUME's own writers would leave behind, so the rollups read them as they would live.
 */
export function analyticsSeed(h: Harness) {
  const MIN = 60_000;
  return {
    async source(name: string): Promise<string> {
      const id = randomUUID();
      await h.ownerPool.query("INSERT INTO lead_sources (id, type, name) VALUES ($1, 'manual', $2)", [
        id,
        name,
      ]);
      return id;
    },
    async lead(o: {
      owner: string | null;
      at: Date;
      source?: string;
      wonAt?: Date;
      value?: number;
      lostAt?: Date;
      phoneStatus?: string;
    }): Promise<string> {
      const id = await h.seedLead({ ownerId: o.owner });
      await h.queryAll(
        `UPDATE leads SET created_at = $2, source_id = $3, won_at = $4, value = $5, lost_at = $6,
                phone_status = coalesce($7, phone_status) WHERE id = $1`,
        [
          id,
          o.at,
          o.source ?? null,
          o.wonAt ?? null,
          o.value ?? null,
          o.lostAt ?? null,
          o.phoneStatus ?? null,
        ],
      );
      return id;
    },
    /** First contact `mins` after `at` (an opened WhatsApp), and a reply an hour later if asked. */
    async contact(lead: string, at: Date, mins: number, replied = false): Promise<void> {
      const t = new Date(at.getTime() + mins * MIN);
      await h.queryAll(
        "INSERT INTO activities (id, lead_id, type, occurred_at) VALUES (gen_random_uuid(), $1, 'whatsapp_opened', $2)",
        [lead, t],
      );
      if (replied)
        await h.queryAll(
          "INSERT INTO activities (id, lead_id, type, occurred_at) VALUES (gen_random_uuid(), $1, 'reply_logged', $2)",
          [lead, new Date(t.getTime() + 60 * MIN)],
        );
    },
    async meeting(o: {
      lead: string;
      owner: string;
      startsAt: Date;
      status: "scheduled" | "completed" | "no_show" | "cancelled" | "rescheduled";
      createdAt?: Date;
    }): Promise<string> {
      const id = randomUUID();
      // A meeting is written by the person whose calendar it's on (its row-level security), so act as them.
      const c = await h.ownerPool.connect();
      try {
        await c.query("BEGIN");
        await c.query(
          "SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)",
          [o.owner],
        );
        await c.query(
          `INSERT INTO meetings (id, lead_id, owner_id, source, external_id, matched_by, title, starts_at, ends_at, status, created_at)
           VALUES ($1, $2, $3, 'calendly', $7, 'calendly', 'Call', $4, $4::timestamptz + interval '30 minutes', $5, $6)`,
          [
            id,
            o.lead,
            o.owner,
            o.startsAt,
            o.status,
            o.createdAt ?? new Date(o.startsAt.getTime() - 86_400_000),
            id,
          ],
        );
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
      return id;
    },
    /** A follow-up due at `due`, done at `done` (or still open). */
    async task(lead: string, assignee: string, due: Date, done: Date | null): Promise<void> {
      await h.queryAll(
        `INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, status, series_id, done_at)
         VALUES (gen_random_uuid(), $1, $2, 'Call back', $3, $4, gen_random_uuid(), $5)`,
        [lead, assignee, due, done ? "done" : "open", done],
      );
    },
    async team(name: string, members: string[]): Promise<string> {
      const id = randomUUID();
      await h.ownerPool.query("INSERT INTO teams (id, name) VALUES ($1, $2)", [id, name]);
      for (const m of members)
        await h.ownerPool.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)", [id, m]);
      return id;
    },
  };
}

/** June 2026 days, the range most analytics tests read. */
export const JUNE = Array.from({ length: 30 }, (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}`);
export const MAY = Array.from({ length: 31 }, (_, i) => `2026-05-${String(i + 1).padStart(2, "0")}`);
export const at = (month: number, day: number, hour = 5, minute = 0) =>
  new Date(Date.UTC(2026, month - 1, day, hour, minute));
