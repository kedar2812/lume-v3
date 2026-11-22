import { sql } from "drizzle-orm";
import { can, newId } from "@lume/core";
import { loadActor } from "../../rbac/actor";
import { jobServer, withJobRequest } from "../imports/job-request";
import { igGraph } from "./graph";
import { handleOf, leadByHandle } from "./leads";
import type { InstagramJobDeps } from "./process";
import { igGraphOf, igTokenContext } from "./service";
import { tokenRefused } from "./token-refresh";

type Row = {
  thread_id: string;
  igsid: string;
  lead_id: string | null;
  profile_read_at: Date | null;
  account_id: string;
  ig_user_id: string;
  username: string;
  status: string;
  owner_user_id: string | null;
  run_as: string;
  source_id: string | null;
  new_dm_creates_lead: boolean;
  token_enc: Buffer | null;
};

/**
 * A person's name and username, read when it couldn't be at their first message (Meta was down). With it, a
 * conversation still waiting for its lead finds the lead with that handle, or becomes one; a lead made meanwhile
 * gets its handle if it had none. Meta refusing the token puts the account in "needs attention"; a refusal of consent
 * is final (never asked again).
 */
export async function readInstagramProfile(o: InstagramJobDeps, threadId: string): Promise<"done" | "later"> {
  const { d } = o;
  const pool = d.jobPool ?? d.pool;
  const c = await pool.connect();
  let row: Row | undefined;
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.lead_scope', 'all', true)");
    row = (
      await c.query<Row>(
        `SELECT t.id AS thread_id, t.igsid, t.lead_id, t.profile_read_at, a.id AS account_id, a.ig_user_id, a.username,
                a.status, a.owner_user_id, a.run_as, a.source_id, a.new_dm_creates_lead, a.token_enc
           FROM instagram_threads t JOIN instagram_accounts a ON a.id = t.account_id WHERE t.id = $1`,
        [threadId],
      )
    ).rows[0];
    await c.query("COMMIT");
  } finally {
    c.release();
  }
  if (!row || row.profile_read_at || row.status !== "active" || !row.token_enc) return "done";
  const r = await igGraph(
    igGraphOf(d),
    d.keyring.decrypt(row.token_enc, igTokenContext(row.account_id)),
  ).profile(row.igsid);
  const code = (r.data.error as { code?: unknown } | undefined)?.code;
  if (code === 190) {
    await tokenRefused(pool, row.account_id);
    return "done";
  }
  if (!r.ok && (r.status === 0 || r.status >= 500)) return "later";
  const username = r.ok && typeof r.data.username === "string" ? r.data.username : null;
  const name = r.ok && typeof r.data.name === "string" && r.data.name.trim() ? r.data.name.trim() : null;
  const actor = await loadActor(pool, row.run_as);
  if (!actor || !can(actor, "leads.view")) return "done";
  const ownerUserId = row.owner_user_id;
  await withJobRequest(
    { app: jobServer(o.app), pool, actor, requestId: `instagram-profile:${threadId}`, allLeads: true },
    async (req) => {
      const t = (
        await req.db.execute<{ lead_id: string | null; profile_read_at: Date | null }>(
          sql`SELECT lead_id, profile_read_at FROM instagram_threads WHERE id = ${threadId} FOR UPDATE`,
        )
      ).rows[0];
      if (!t || t.profile_read_at) return;
      await req.db.execute(sql`
        UPDATE instagram_threads SET username = coalesce(${username}, username), name = coalesce(${name}, name),
               profile_read_at = now() WHERE id = ${threadId}`);
      const h = handleOf(username);
      if (t.lead_id) {
        // A lead made before LUME knew who it was: its handle, if it has none yet.
        if (h)
          await req.db.execute(
            sql`UPDATE leads SET instagram_handle = ${h} WHERE id = ${t.lead_id} AND instagram_handle IS NULL`,
          );
        return;
      }
      // Still waiting in Not a lead yet: the lead with this handle takes the conversation (and its messages).
      const leadId = await leadByHandle(req, username, ownerUserId);
      if (leadId) {
        await req.db.execute(sql`UPDATE instagram_threads SET lead_id = ${leadId} WHERE id = ${threadId}`);
        await moveInboxToLead(req, threadId, leadId, ownerUserId);
      }
    },
  );
  return "done";
}

/**
 * Not a lead yet's messages onto the lead they now belong to, in their own order and times. Each gets LUME's own
 * time-ordered id, written in that order, so two messages with the same second keep the order they came in.
 */
export async function moveInboxToLead(
  req: Parameters<Parameters<typeof withJobRequest>[1]>[0],
  threadId: string,
  leadId: string,
  userId: string | null,
) {
  const rows = (
    await req.db.execute<{
      mid: string;
      at: Date | string;
      text: string | null;
      detail: Record<string, unknown>;
      unsent: boolean;
    }>(sql`
      SELECT i.mid, i.at, i.text, i.detail, i.unsent FROM instagram_inbox i
       WHERE i.thread_id = ${threadId}
         AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.lead_id = ${leadId}
                           AND a.type = 'instagram_received' AND a.payload->>'mid' = i.mid)
       ORDER BY i.at, i.created_at, i.id`)
  ).rows;
  for (const m of rows)
    await req.db.execute(sql`
      INSERT INTO activities (id, lead_id, user_id, type, occurred_at, payload)
      VALUES (${newId()}, ${leadId}, ${userId}, 'instagram_received', ${new Date(m.at)},
              ${JSON.stringify({ mid: m.mid, threadId, text: m.unsent ? null : m.text, ...(m.unsent ? {} : m.detail), unsent: m.unsent })}::jsonb)`);
  await req.db.execute(
    sql`UPDATE instagram_media SET lead_id = ${leadId} WHERE thread_id = ${threadId} AND lead_id IS NULL`,
  );
  await req.db.execute(sql`DELETE FROM instagram_inbox WHERE thread_id = ${threadId}`);
}
