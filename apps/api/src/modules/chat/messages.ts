import { CHAT_LIMITS, bodyOf, bodyProblem } from "@lume/core";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { audit } from "../../audit/audit";
import { badRequest, notFound } from "../../http/errors";
import { bigints, convOf, tell, uuids } from "./conversations";

/**
 * Team Chat's messages (plan 2026-11-24-team-chat-2a, Task 4): read and written as the person, so a conversation they
 * can't read is simply not there. A deleted message keeps its row for the audit, but its words and files are never
 * served again.
 */

export type FileView = { id: string; name: string; mime: string; kind: string; size: number; url: string };
export type MessageView = {
  id: number;
  conversationId: string;
  authorId: string | null;
  /** The browser's own id for a send, to its sender alone (so a message being sent is never shown twice). */
  clientId: string | null;
  kind: "text" | "system";
  body: string | null;
  replyTo: { id: number; authorId: string | null; body: string | null } | null;
  files: FileView[];
  reactions: { emoji: string; count: number; mine: boolean }[];
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
};

type Row = {
  id: string;
  conversation_id: string;
  author_id: string | null;
  client_id: string | null;
  kind: "text" | "system";
  body: string | null;
  reply_to: string | null;
  edited_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
};
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

/** Messages as the screen shows them: with what they reply to, their files and reactions; deleted ones emptied. */
async function viewsOf(req: FastifyRequest, rows: Row[]): Promise<MessageView[]> {
  if (!rows.length) return [];
  const me = req.actor!.userId;
  const ids = rows.map((r) => Number(r.id));
  const replyIds = [...new Set(rows.map((r) => r.reply_to).filter((x): x is string => !!x))].map(Number);
  const replies = replyIds.length
    ? (
        await req.db.execute<{
          id: string;
          author_id: string | null;
          body: string | null;
          deleted_at: Date | null;
        }>(
          sql`SELECT id, author_id, body, deleted_at FROM chat_messages WHERE id = ANY(${bigints(replyIds)})`,
        )
      ).rows
    : [];
  const files = (
    await req.db.execute<{
      id: string;
      message_id: string;
      name: string;
      mime: string;
      kind: string;
      size: string;
    }>(
      sql`SELECT id, message_id, name, mime, kind, size FROM chat_files WHERE message_id = ANY(${bigints(ids)}) ORDER BY created_at, id`,
    )
  ).rows;
  const reacts = (
    await req.db.execute<{ message_id: string; emoji: string; count: number; mine: boolean }>(sql`
      SELECT message_id, emoji, count(*)::int AS count, bool_or(user_id = ${me}) AS mine
      FROM chat_reactions WHERE message_id = ANY(${bigints(ids)})
      GROUP BY message_id, emoji ORDER BY count(*) DESC, emoji`)
  ).rows;
  return rows.map((r) => {
    const gone = r.deleted_at !== null;
    const q = r.reply_to ? replies.find((x) => x.id === r.reply_to) : undefined;
    return {
      id: Number(r.id),
      conversationId: r.conversation_id,
      authorId: r.author_id,
      clientId: r.author_id === me ? r.client_id : null,
      kind: r.kind,
      body: gone ? null : r.body,
      replyTo:
        q && !gone ? { id: Number(q.id), authorId: q.author_id, body: q.deleted_at ? null : q.body } : null,
      files: gone
        ? []
        : files
            .filter((f) => f.message_id === r.id)
            .map((f) => ({
              id: f.id,
              name: f.name,
              mime: f.mime,
              kind: f.kind,
              size: Number(f.size),
              url: `/api/v1/chat/files/${f.id}`,
            })),
      reactions: gone
        ? []
        : reacts
            .filter((x) => x.message_id === r.id)
            .map((x) => ({ emoji: x.emoji, count: x.count, mine: x.mine })),
      editedAt: iso(r.edited_at),
      deletedAt: iso(r.deleted_at),
      createdAt: iso(r.created_at)!,
    };
  });
}

const COLS = sql`id, conversation_id, author_id, client_id, kind, body, reply_to, edited_at, deleted_at, created_at`;

export type MessagePage = {
  messages: MessageView[];
  /** Older ones before the first here (or newer after the last, asking `after`). */
  more: boolean;
  /** Where the person has read up to; null when they keep no place here (a lead's thread they only look at). */
  lastReadId: number | null;
  /** Where the others have received and read up to: in a direct message only. */
  members: { userId: string; lastReadId: number; lastDeliveredId: number }[];
};
/** A page of 50: the newest by default, older than `before`, or newer than `after`; oldest first within it. */
export async function messagesOf(
  req: FastifyRequest,
  id: string,
  q: { before?: number | undefined; after?: number | undefined },
): Promise<MessagePage> {
  const me = req.actor!.userId;
  const c = await convOf(req, id);
  const n = CHAT_LIMITS.page;
  const got =
    q.after !== undefined
      ? (
          await req.db.execute<Row>(
            sql`SELECT ${COLS} FROM chat_messages WHERE conversation_id = ${id} AND id > ${q.after} ORDER BY id LIMIT ${n + 1}`,
          )
        ).rows
      : (
          await req.db.execute<Row>(sql`
            SELECT ${COLS} FROM chat_messages WHERE conversation_id = ${id}
              ${q.before !== undefined ? sql`AND id < ${q.before}` : sql``}
            ORDER BY id DESC LIMIT ${n + 1}`)
        ).rows;
  const rows = got.slice(0, n);
  if (q.after === undefined) rows.reverse();
  // Someone who has left never holds a tick back. In a channel only one's own mark is asked for: a thousand people's would come with every page.
  const marks = (
    await req.db.execute<{ user_id: string; last_read_id: string; last_delivered_id: string }>(sql`
      SELECT m.user_id, m.last_read_id, m.last_delivered_id FROM chat_members m
      JOIN users u ON u.id = m.user_id AND (u.status = 'active' OR u.id = ${me})
      WHERE m.conversation_id = ${id} ${c.kind === "direct" ? sql`` : sql`AND m.user_id = ${me}`}`)
  ).rows;
  const mine = marks.find((m) => m.user_id === me);
  return {
    messages: await viewsOf(req, rows),
    more: got.length > n,
    lastReadId: mine ? Number(mine.last_read_id) : null,
    members:
      c.kind === "direct"
        ? marks.map((m) => ({
            userId: m.user_id,
            lastReadId: Number(m.last_read_id),
            lastDeliveredId: Number(m.last_delivered_id),
          }))
        : [],
  };
}

async function oneOf(req: FastifyRequest, mid: number): Promise<MessageView> {
  const rows = (await req.db.execute<Row>(sql`SELECT ${COLS} FROM chat_messages WHERE id = ${mid}`)).rows;
  return (await viewsOf(req, rows))[0]!;
}

/**
 * Where the person has read (and so received) up to; never backwards, never past the conversation's last message. Their
 * place is only moved here, never made: someone just taken out stays out, and looking at a lead's thread isn't following
 * it. The mark as it stands after, or null when they have none here or it didn't move.
 */
async function markRead(
  req: FastifyRequest,
  c: { id: string; kind: string },
  upTo: number,
  o: { delivered?: boolean } = {},
): Promise<number | null> {
  const me = req.actor!.userId;
  const top = sql`(SELECT least(${upTo}::bigint, coalesce(max(id), 0)) FROM chat_messages WHERE conversation_id = ${c.id})`;
  const row = (
    await req.db.execute<{ n: string }>(sql`
      UPDATE chat_members SET
        last_delivered_id = greatest(last_delivered_id, ${top})
        ${o.delivered ? sql`` : sql`, last_read_id = greatest(last_read_id, ${top})`}
      WHERE conversation_id = ${c.id} AND user_id = ${me}
        AND (last_delivered_id < ${top} ${o.delivered ? sql`` : sql`OR last_read_id < ${top}`})
      RETURNING ${o.delivered ? sql`last_delivered_id` : sql`last_read_id`} AS n`)
  ).rows[0];
  return row ? Number(row.n) : null;
}

export async function sendMessage(
  req: FastifyRequest,
  id: string,
  b: {
    clientId: string;
    body?: string | undefined;
    replyTo?: number | undefined;
    files?: string[] | undefined;
  },
): Promise<{ created: boolean; message: MessageView }> {
  const me = req.actor!.userId;
  const c = await convOf(req, id);
  const text = bodyOf(b.body ?? "");
  const files = [...new Set(b.files ?? [])];
  if (files.length > CHAT_LIMITS.files)
    throw badRequest("FILES", `A message can carry at most ${CHAT_LIMITS.files} files.`);
  const problem = bodyProblem(text, files.length > 0);
  if (problem) throw badRequest("BODY", problem);
  // The same send again (a retry, another tab): it is that message, whether it landed already or lands meanwhile.
  const again = async () =>
    (
      await req.db.execute<{ id: string }>(
        sql`SELECT id FROM chat_messages WHERE conversation_id = ${id} AND author_id = ${me} AND client_id = ${b.clientId}`,
      )
    ).rows[0];
  // One send at a time in a conversation: ids are handed out in the order messages land, so a screen that has the
  // newest has every one before it, and a retry sees the send it repeats.
  await req.db.execute(sql`SELECT 1 FROM chat_conversations WHERE id = ${id} FOR NO KEY UPDATE`);
  const had = await again();
  if (had) return { created: false, message: await oneOf(req, Number(had.id)) };
  if (b.replyTo !== undefined) {
    const to = (
      await req.db.execute<{ id: string }>(
        sql`SELECT id FROM chat_messages WHERE id = ${b.replyTo} AND conversation_id = ${id} AND deleted_at IS NULL`,
      )
    ).rows[0];
    if (!to) throw badRequest("REPLY", "That message can't be replied to.");
  }
  if (files.length) {
    // Row security: a file waiting to be sent is seen by whoever put it there, and no one else.
    const mine = (
      await req.db.execute<{ id: string }>(
        sql`SELECT id FROM chat_files WHERE id = ANY(${uuids(files)}) AND message_id IS NULL FOR UPDATE`,
      )
    ).rows;
    if (mine.length !== files.length)
      throw badRequest("FILES", "A file here was already sent, or isn't yours to send.");
  }
  const made = (
    await req.db.execute<{ id: string }>(sql`
      INSERT INTO chat_messages (conversation_id, author_id, body, reply_to, client_id)
      VALUES (${id}, ${me}, ${text || null}, ${b.replyTo ?? null}, ${b.clientId})
      ON CONFLICT (conversation_id, author_id, client_id) DO NOTHING RETURNING id`)
  ).rows[0];
  if (!made) {
    const raced = await again();
    return { created: false, message: await oneOf(req, Number(raced!.id)) };
  }
  const mid = Number(made.id);
  if (files.length)
    await req.db.execute(
      sql`UPDATE chat_files SET message_id = ${mid} WHERE id = ANY(${uuids(files)}) AND message_id IS NULL`,
    );
  await req.db.execute(sql`
    UPDATE chat_conversations SET last_message_id = greatest(coalesce(last_message_id, 0), ${mid}), last_at = now()
    WHERE id = ${id}`);
  // One's own message is read by them.
  if (c.kind === "lead") {
    // Writing in a lead's thread follows it, and so does whoever the lead is.
    await req.db.execute(sql`
      INSERT INTO chat_members (conversation_id, user_id, via) VALUES (${id}, ${me}, 'lead') ON CONFLICT DO NOTHING`);
    await req.db.execute(sql`SELECT lume_chat_follow_owner(${id})`);
  }
  await markRead(req, c, mid);
  await tell(req, { c: id, e: "message", m: mid, u: me });
  return { created: true, message: await oneOf(req, mid) };
}

/** 404 unless it's the person's own message (someone else's can't be changed, and isn't said to exist). */
async function ownOf(req: FastifyRequest, mid: number) {
  const row = (
    await req.db.execute<{
      conversation_id: string;
      body: string | null;
      deleted_at: Date | null;
      files: number;
    }>(sql`
      SELECT m.conversation_id, m.body, m.deleted_at, (SELECT count(*)::int FROM chat_files f WHERE f.message_id = m.id) AS files
      FROM chat_messages m WHERE m.id = ${mid} AND m.author_id = ${req.actor!.userId} FOR UPDATE OF m`)
  ).rows[0];
  if (!row || row.deleted_at) throw notFound("NOT_FOUND", "That message isn't there.");
  // Nothing changes in an archived channel.
  await convOf(req, row.conversation_id);
  return row;
}

export async function editMessage(req: FastifyRequest, mid: number, body: string): Promise<MessageView> {
  const m = await ownOf(req, mid);
  const text = bodyOf(body);
  const problem = bodyProblem(text, m.files > 0);
  if (problem) throw badRequest("BODY", problem);
  if (text !== (m.body ?? "")) {
    if (m.body !== null)
      await req.db.execute(sql`INSERT INTO chat_message_edits (message_id, body) VALUES (${mid}, ${m.body})`);
    await req.db.execute(
      sql`UPDATE chat_messages SET body = ${text || null}, edited_at = now() WHERE id = ${mid}`,
    );
    await audit(req, { action: "chat.message.edited", entityType: "chat_message", entityId: String(mid) });
    await tell(req, { c: m.conversation_id, e: "edited", m: mid });
  }
  return oneOf(req, mid);
}

export async function deleteMessage(req: FastifyRequest, mid: number): Promise<void> {
  const m = await ownOf(req, mid);
  await req.db.execute(sql`UPDATE chat_messages SET deleted_at = now() WHERE id = ${mid}`);
  await audit(req, { action: "chat.message.deleted", entityType: "chat_message", entityId: String(mid) });
  await tell(req, { c: m.conversation_id, e: "deleted", m: mid });
}

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
/** One emoji (with its skin tone or joined family), nothing else. */
export function isOneEmoji(s: string): boolean {
  if (!s || Buffer.byteLength(s) > 32) return false;
  const parts = [...segmenter.segment(s)];
  return parts.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s);
}

export async function react(req: FastifyRequest, mid: number, emoji: string, on: boolean): Promise<void> {
  if (!isOneEmoji(emoji)) throw badRequest("EMOJI", "A reaction is one emoji.");
  const m = (
    await req.db.execute<{ conversation_id: string; deleted_at: Date | null }>(
      sql`SELECT conversation_id, deleted_at FROM chat_messages WHERE id = ${mid}`,
    )
  ).rows[0];
  if (!m) throw notFound("NOT_FOUND", "That message isn't there.");
  await convOf(req, m.conversation_id);
  if (on) {
    if (m.deleted_at) throw badRequest("DELETED", "That message was deleted.");
    await req.db.execute(sql`
      INSERT INTO chat_reactions (message_id, user_id, emoji) VALUES (${mid}, ${req.actor!.userId}, ${emoji})
      ON CONFLICT DO NOTHING`);
  } else
    await req.db.execute(
      sql`DELETE FROM chat_reactions WHERE message_id = ${mid} AND user_id = ${req.actor!.userId} AND emoji = ${emoji}`,
    );
  await tell(req, { c: m.conversation_id, e: "reaction", m: mid });
}

/** The person's read mark. In a direct message the other person sees it; elsewhere only their own other tabs hear. */
export async function read(req: FastifyRequest, id: string, upTo: number): Promise<void> {
  const c = await convOf(req, id);
  const at = await markRead(req, c, upTo);
  if (at !== null) await tell(req, { c: id, e: "read", m: at, u: req.actor!.userId });
}

/** A message reached one of the person's devices: a direct message's Delivered, and nothing anywhere else. */
export async function delivered(req: FastifyRequest, id: string, upTo: number): Promise<void> {
  const c = await convOf(req, id);
  if (c.kind !== "direct") return;
  const at = await markRead(req, c, upTo, { delivered: true });
  if (at !== null) await tell(req, { c: id, e: "delivered", m: at, u: req.actor!.userId });
}
