import { CHAT_LIMITS } from "@lume/core";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { badRequest, notFound } from "../../http/errors";
import { convOf, convsOf, tell, type ConvRow } from "./conversations";
import { settleNotices, type Notices } from "./notices";
import { COLS, sendMessage, viewsOf, type MessagePage, type MessageView, type Row } from "./messages";

/**
 * Team Chat's threads (plan 2026-11-25-team-chat-2b, Task 1): replies that hang on one message, read apart from the
 * conversation. Who may read a thread is who may read its conversation; a person follows one once they wrote its first
 * message or a reply, until they stop.
 */

/** The thread this message starts or is in; 404 when the message, or its conversation, isn't there for them. */
async function rootOf(
  req: FastifyRequest,
  mid: number,
): Promise<{ id: number; conversation: string; gone: boolean; has: boolean }> {
  // By its own id, then by its root's: each a look-up by key (a join on the two can't use one under row security).
  const m = (
    await req.db.execute<{ root: string }>(
      sql`SELECT coalesce(thread_root, id) AS root FROM chat_messages WHERE id = ${mid}`,
    )
  ).rows[0];
  const row = m
    ? (
        await req.db.execute<{ id: string; conversation_id: string; gone: boolean; has: boolean }>(sql`
          SELECT r.id, r.conversation_id, r.deleted_at IS NOT NULL AS gone,
            EXISTS (SELECT 1 FROM chat_threads t WHERE t.root_id = r.id) AS has
          FROM chat_messages r WHERE r.id = ${Number(m.root)}`)
      ).rows[0]
    : undefined;
  if (!row) throw notFound("NOT_FOUND", "That message isn't there.");
  await convOf(req, row.conversation_id);
  return { id: Number(row.id), conversation: row.conversation_id, gone: row.gone, has: row.has };
}

export type ThreadPage = MessagePage & {
  root: number;
  conversationId: string;
  following: boolean;
};
/** A page of 50 of the thread, its first message among them: newest by default, as a conversation's. */
export async function threadPage(
  req: FastifyRequest,
  mid: number,
  q: { before?: number | undefined; after?: number | undefined },
): Promise<ThreadPage> {
  const root = await rootOf(req, mid);
  const n = CHAT_LIMITS.page;
  const [at, order, inThread] =
    q.after !== undefined
      ? [sql`AND id > ${q.after}`, sql`ORDER BY id`, sql`ORDER BY thread_root, id`]
      : [
          q.before !== undefined ? sql`AND id < ${q.before}` : sql``,
          sql`ORDER BY id DESC`,
          sql`ORDER BY thread_root DESC, id DESC`,
        ];
  const got = (
    await req.db.execute<Row>(sql`
      SELECT * FROM (
        -- In the thread's own order, so its index is read and nothing else (a thread of three in a channel of a million).
        (SELECT ${COLS} FROM chat_messages WHERE thread_root = ${root.id} ${at} ${inThread} LIMIT ${n + 1})
        UNION ALL
        (SELECT ${COLS} FROM chat_messages WHERE id = ${root.id} ${at})
      ) AS t ${order} LIMIT ${n + 1}`)
  ).rows;
  const rows = got.slice(0, n);
  if (q.after === undefined) rows.reverse();
  const mine = (
    await req.db.execute<{ last_read_id: string; following: boolean }>(
      sql`SELECT last_read_id, following FROM chat_thread_places WHERE root_id = ${root.id} AND user_id = ${req.actor!.userId}`,
    )
  ).rows[0];
  return {
    root: root.id,
    conversationId: root.conversation,
    messages: await viewsOf(req, rows),
    more: got.length > n,
    lastReadId: mine ? Number(mine.last_read_id) : null,
    following: mine?.following ?? false,
    members: [],
  };
}

export async function replyInThread(
  req: FastifyRequest,
  notices: Notices,
  mid: number,
  b: {
    clientId: string;
    body?: string | undefined;
    replyTo?: number | undefined;
    files?: string[] | undefined;
    alsoSend?: boolean | undefined;
  },
): Promise<{ created: boolean; message: MessageView }> {
  const root = await rootOf(req, mid);
  // A thread already there goes on under a deleted message; a new one isn't started there.
  if (root.gone && !root.has) throw badRequest("DELETED", "That message was deleted.");
  const { alsoSend, ...message } = b;
  return sendMessage(req, notices, root.conversation, message, { root: root.id, also: alsoSend ?? false });
}

/** Where they've read the thread up to; only a place they have is moved, and never backwards. Their other tabs hear. */
export async function readThread(req: FastifyRequest, mid: number, upTo: number): Promise<void> {
  const root = await rootOf(req, mid);
  const me = req.actor!.userId;
  const row = (
    await req.db.execute<{ n: string }>(sql`
      WITH t AS (SELECT coalesce(max(last_reply_id), 0) AS n FROM chat_threads WHERE root_id = ${root.id})
      UPDATE chat_thread_places p SET last_read_id = least(${upTo}::bigint, greatest(p.last_reply_id, t.n)) FROM t
      WHERE p.root_id = ${root.id} AND p.user_id = ${me}
        AND p.last_read_id < least(${upTo}::bigint, greatest(p.last_reply_id, t.n))
      RETURNING p.last_read_id AS n`)
  ).rows[0];
  if (row) await tell(req, { c: root.conversation, e: "read", m: Number(row.n), u: me, t: root.id });
  await settleNotices(req, root.conversation, root.id, upTo);
}

/** Follow, from now on (what was said before isn't waiting); or stop, until they reply again. */
export async function followThread(req: FastifyRequest, mid: number, on: boolean): Promise<void> {
  const root = await rootOf(req, mid);
  const me = req.actor!.userId;
  const moved = (
    await req.db.execute<{ n: number }>(
      on
        ? sql`
          INSERT INTO chat_thread_places AS p (root_id, user_id, last_read_id, last_reply_id)
          SELECT ${root.id}, ${me}, coalesce(max(t.last_reply_id), 0), coalesce(max(t.last_reply_id), 0)
          FROM chat_threads t WHERE t.root_id = ${root.id}
          ON CONFLICT (root_id, user_id) DO UPDATE SET following = true,
            last_read_id = greatest(p.last_read_id, EXCLUDED.last_read_id)
          WHERE NOT p.following RETURNING 1 AS n`
        : sql`
          UPDATE chat_thread_places SET following = false
          WHERE root_id = ${root.id} AND user_id = ${me} AND following RETURNING 1 AS n`,
    )
  ).rows[0];
  // Their other tabs: what's unread is different now.
  if (moved) await tell(req, { c: root.conversation, e: "read", m: root.id, u: me, t: root.id });
}

export type ThreadRow = { root: MessageView; conversation: ConvRow; unread: number };
const SHOWN = 50;
/** How many of their places are looked at for one go (some may be in conversations they've left since). */
export const threadTuning = { places: 200, goes: 20 };
/** The threads a person follows, the newest reply first: fifty, each with what's new in it. */
export async function threadsOf(req: FastifyRequest): Promise<{ threads: ThreadRow[] }> {
  const me = req.actor!.userId;
  type T = {
    root_id: string;
    conversation_id: string;
    last_read_id: string;
    last_reply_id: string;
    seen: boolean;
  };
  const found: T[] = [];
  // Compiling these would cost more than running them (row-level security makes them long).
  await req.db.execute(sql`SELECT set_config('jit', 'off', true)`);
  let before: string | null = null;
  for (let i = 0; i < threadTuning.goes && found.length < SHOWN; i++) {
    const rows: T[] = (
      await req.db.execute<T>(sql`
        WITH mine AS (
          SELECT root_id, last_read_id, last_reply_id FROM chat_thread_places
          WHERE user_id = ${me} AND following AND last_reply_id > 0 ${before === null ? sql`` : sql`AND last_reply_id < ${before}`}
          ORDER BY last_reply_id DESC LIMIT ${threadTuning.places})
        SELECT mine.*, t.conversation_id, coalesce(t.replies > 0 AND c.archived_at IS NULL AND c.id IS NOT NULL, false) AS seen
        FROM mine LEFT JOIN chat_threads t ON t.root_id = mine.root_id
        LEFT JOIN chat_conversations c ON c.id = t.conversation_id
        ORDER BY mine.last_reply_id DESC`)
    ).rows;
    found.push(...rows.filter((r) => r.seen));
    if (rows.length < threadTuning.places) break;
    before = rows.at(-1)!.last_reply_id;
  }
  const shown = found.slice(0, SHOWN);
  const unread = new Map(
    shown.length
      ? (
          await req.db.execute<{ root_id: string; n: number }>(sql`
            SELECT p.root_id, (SELECT count(*)::int FROM (
              SELECT 1 FROM chat_messages m
              WHERE m.thread_root = p.root_id AND m.id > p.last_read_id AND m.deleted_at IS NULL AND NOT m.also_sent
              LIMIT 100) AS u) AS n
            FROM chat_thread_places p
            WHERE p.user_id = ${me} AND p.root_id = ANY(${`{${shown.map((t) => t.root_id).join(",")}}`}::bigint[])`)
        ).rows.map((r) => [r.root_id, r.n])
      : [],
  );
  const convs = await convsOf(req, [...new Set(shown.map((t) => t.conversation_id))]);
  const roots = shown.length
    ? await viewsOf(
        req,
        (
          await req.db.execute<Row>(
            sql`SELECT ${COLS} FROM chat_messages WHERE id = ANY(${`{${shown.map((t) => t.root_id).join(",")}}`}::bigint[])`,
          )
        ).rows,
      )
    : [];
  return {
    threads: shown.flatMap((t) => {
      const root = roots.find((r) => r.id === Number(t.root_id));
      const conversation = convs.get(t.conversation_id);
      return root && conversation ? [{ root, conversation, unread: unread.get(t.root_id) ?? 0 }] : [];
    }),
  };
}
