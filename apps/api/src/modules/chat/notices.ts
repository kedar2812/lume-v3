import { can, chatNotice } from "@lume/core";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type pg from "pg";
import { applyRequestScope } from "../../db/context";
import { loadActor } from "../../rbac/actor";
import { readSignal } from "../notifications/hub";
import { wants } from "../notifications/notify";

/**
 * What the bell says of chat (plan 2026-11-25-team-chat-2b, Task 2): a mention, and a direct message. Written a moment
 * after, as the person it is for and under their own access, from what is still unread then: someone looking at the
 * conversation is never told of it, forty messages in a minute are one line that counts, a deleted one takes its notice
 * back, and a lead that has moved away says nothing. It carries a name and a number, never anyone's words.
 */
export type NoticeKey = { userId: string; conv: string; kind: "chat_mention" | "chat_direct"; root: number };
export type Notices = {
  soon(k: NoticeKey, again?: boolean): void;
  /** Everything waiting has been written (each at its own time): what a test waits on, never a guess at how long. */
  settled(): Promise<void>;
  stop(): Promise<void>;
};
/** Every queue this process runs (one per app). */
const queues = new Set<Notices>();
/** Every queue has written what it was waiting to write: for tests, so they wait on the work, not on a clock. */
export const noticesSettled = async (): Promise<void> => {
  await Promise.all([...queues].map((q) => q.settled()));
};
/**
 * How long a notice waits for the conversation to be read: longer than a tab looking at it takes to say so (a mention in
 * a busy channel is caught up with in a few seconds, and then said at once); and how many are written at a time, so
 * naming a thousand people never takes the connections everyone else is waiting for. Tests shorten the first two.
 */
export const noticeTuning = { direct: 3500, mention: 7000, atOnce: 2 };

/** Tells them once this request has committed; `again`: only puts right what the bell already says. */
export const noteChat = (req: FastifyRequest, notices: Notices, k: NoticeKey, again = false): void =>
  req.afterCommit(() => notices.soon(k, again));

export function createNotices(pool: pg.Pool, onError: (err: unknown) => void): Notices {
  type One = { k: NoticeKey; again: boolean };
  const waiting = new Map<string, One & { t: NodeJS.Timeout }>();
  const queue: One[] = [];
  let going = 0;
  let idle: (() => void)[] = [];
  const next = () => {
    while (going < noticeTuning.atOnce && queue.length) {
      const o = queue.shift()!;
      going++;
      void fire(pool, o.k, o.again)
        .catch(onError)
        .finally(() => {
          going--;
          next();
        });
    }
    if (!going && !queue.length) {
      for (const f of idle) f();
      idle = [];
    }
  };
  const self: Notices = {
    soon(k, again = false) {
      const key = `${k.userId}:${k.conv}:${k.kind}:${k.root}`;
      const had = waiting.get(key);
      if (had) {
        had.again &&= again;
        return;
      }
      const one: One & { t: NodeJS.Timeout } = {
        k,
        again,
        t: setTimeout(
          () => {
            waiting.delete(key);
            queue.push(one);
            next();
          },
          k.kind === "chat_direct" ? noticeTuning.direct : noticeTuning.mention,
        ),
      };
      one.t.unref();
      waiting.set(key, one);
    },
    async settled() {
      // Each pass waits for the queue to empty; a notice still waiting for its moment fills it again first.
      while (waiting.size || queue.length || going) {
        if (!queue.length && !going) {
          await new Promise((r) => setTimeout(r, 10));
          continue;
        }
        await new Promise<void>((r) => idle.push(r));
      }
    },
    /** LUME is closing (an update): whatever was waiting is told now. */
    async stop() {
      for (const one of waiting.values()) {
        clearTimeout(one.t);
        queue.push(one);
      }
      waiting.clear();
      const done = new Promise<void>((r) => idle.push(r));
      next();
      await done;
      queues.delete(self);
    },
  };
  queues.add(self);
  return self;
}

type Said = { n: number; newest: string | null; by: string | null };
async function fire(pool: pg.Pool, k: NoticeKey, again: boolean): Promise<void> {
  // One connection for all of it.
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const actor = await loadActor(c, k.userId);
    if (!actor || !can(actor, "chat.use")) {
      await c.query("COMMIT");
      c.release();
      return;
    }
    await applyRequestScope(c, actor);
    // One at a time for each line in the bell.
    await c.query("SELECT pg_advisory_xact_lock(hashtext('lume_chat_notice'), hashtext($1))", [
      `${k.userId}:${k.conv}:${k.kind}:${k.root}`,
    ]);
    const line = [k.userId, k.conv, k.kind, k.root];
    const stands = again
      ? (
          await c.query(
            "SELECT 1 FROM notifications WHERE user_id = $1 AND conversation_id = $2 AND kind = $3 AND chat_root = $4 AND read_at IS NULL",
            line,
          )
        ).rowCount
      : 1;
    if (!stands) {
      await c.query("COMMIT");
      c.release();
      return;
    }
    // Held while it's written: a read said meanwhile comes after, and settles it.
    await c.query("SELECT 1 FROM chat_members WHERE conversation_id = $1 AND user_id = $2 FOR SHARE", [
      k.conv,
      k.userId,
    ]);
    await c.query("SELECT 1 FROM chat_thread_places WHERE root_id = $1 AND user_id = $2 FOR SHARE", [
      k.root,
      k.userId,
    ]);
    const conv = (
      await c.query<{
        kind: "channel" | "direct" | "lead";
        name: string | null;
        lead_id: string | null;
        lead: string | null;
        muted: boolean;
        read_to: string;
        people: number;
        preferences: unknown;
      }>(
        `SELECT c.kind, c.name, c.lead_id, l.name AS lead, coalesce(m.muted, false) AS muted,
           coalesce(m.last_read_id, 0) AS read_to,
           (CASE WHEN c.kind = 'direct' THEN (SELECT count(*) FROM chat_members x WHERE x.conversation_id = c.id) ELSE 0 END)::int AS people,
           u.preferences
         FROM chat_conversations c JOIN users u ON u.id = $2
         LEFT JOIN chat_members m ON m.conversation_id = c.id AND m.user_id = $2 LEFT JOIN leads l ON l.id = c.lead_id
         WHERE c.id = $1 AND c.archived_at IS NULL`,
        [k.conv, k.userId],
      )
    ).rows[0];
    // A direct message speaks for itself, names or none; where it's muted or switched off, one's own name still does.
    const spoken =
      conv?.kind === "direct" && k.root === 0 && !conv.muted && wants(conv.preferences, "chat_direct");
    let said: Said | undefined;
    if (conv && wants(conv.preferences, k.kind) && !(k.kind === "chat_direct" ? conv.muted : spoken))
      said = (
        k.kind === "chat_direct"
          ? await c.query<Said>(
              `SELECT count(*)::int AS n, max(id) AS newest, (array_agg(author_id ORDER BY id DESC))[1] AS by FROM (
                 SELECT id, author_id FROM chat_messages
                 WHERE conversation_id = $1 AND id > $2 AND deleted_at IS NULL AND author_id IS DISTINCT FROM $3
                   AND (thread_root IS NULL OR also_sent)
                 ORDER BY id DESC LIMIT 100) AS m`,
              [k.conv, conv.read_to, k.userId],
            )
          : await c.query<Said>(
              `SELECT count(*)::int AS n, max(id) AS newest, (array_agg(author_id ORDER BY id DESC))[1] AS by FROM (
                 SELECT m.id, m.author_id FROM chat_mentions x JOIN chat_messages m ON m.id = x.message_id
                 WHERE x.user_id = $2 AND x.conversation_id = $1 AND x.root = $3 AND NOT x.seen
                   AND m.deleted_at IS NULL AND (x.by_name OR NOT $4)
                 ORDER BY m.id DESC LIMIT 100) AS m`,
              [k.conv, k.userId, k.root, conv.muted],
            )
      ).rows[0];
    const was = await c.query(
      "DELETE FROM notifications WHERE user_id = $1 AND conversation_id = $2 AND kind = $3 AND chat_root = $4 AND read_at IS NULL",
      line,
    );
    if (conv && said && said.n > 0) {
      const by = (await c.query<{ name: string }>("SELECT name FROM users WHERE id = $1", [said.by])).rows[0];
      const ins = await c.query<{ id: string }>(
        `INSERT INTO notifications (user_id, kind, lead_id, title, conversation_id, chat_root, chat_message_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          k.userId,
          k.kind,
          conv.lead_id,
          chatNotice({
            kind: k.kind,
            in: conv.kind,
            name: conv.kind === "lead" ? conv.lead : conv.name,
            by: by?.name ?? "LUME",
            n: said.n,
            group: conv.people > 2,
          }),
          k.conv,
          k.root,
          said.newest,
        ],
      );
      await c.query("SELECT pg_notify('lume_notifications', $1)", [
        JSON.stringify({ u: k.userId, n: Number(ins.rows[0]!.id) }),
      ]);
    } else if (was.rowCount) {
      // Nothing left to say: the bell counts one fewer.
      await c.query("SELECT pg_notify('lume_notifications', $1)", [readSignal(k.userId)]);
    }
    await c.query("COMMIT");
    c.release();
  } catch (e) {
    await c.query("ROLLBACK").then(
      () => c.release(),
      (err: Error) => c.release(err),
    );
    throw e;
  }
}

/** The conversation (or a thread in it) is read up to here: so is what the bell says of it. */
export async function settleNotices(
  req: FastifyRequest,
  conv: string,
  root: number,
  upTo: number,
): Promise<void> {
  const me = req.actor!.userId;
  await req.db.execute(sql`
    UPDATE chat_mentions SET seen = true
    WHERE user_id = ${me} AND conversation_id = ${conv} AND root = ${root} AND NOT seen AND message_id <= ${upTo}`);
  const rows = (
    await req.db.execute<{ n: number }>(sql`
      UPDATE notifications SET read_at = now()
      WHERE user_id = ${me} AND conversation_id = ${conv} AND chat_root = ${root} AND read_at IS NULL
        AND chat_message_id <= ${upTo} RETURNING 1 AS n`)
  ).rows;
  if (rows.length) await req.db.execute(sql`SELECT pg_notify('lume_notifications', ${readSignal(me)})`);
}
