import { CHAT_LIMITS, channelNameProblem, newId } from "@lume/core";
import { sql, type SQL } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { audit } from "../../audit/audit";
import { pgCodeOf } from "../../errors";
import { badRequest, conflict, notFound } from "../../http/errors";

/**
 * Team Chat's conversations (plan 2026-11-24-team-chat-2a, Task 3). Every read and write is the person's own, under
 * row-level security: a channel or direct message only for its members, a lead's thread only for who may see the lead.
 * Who is in a channel is changed by the owner's functions (0130), for whoever manages channels.
 */

export type PersonLite = {
  id: string;
  name: string;
  avatar: { color: string | null; version: number; photo: boolean };
};
export type ConvRow = {
  id: string;
  kind: "channel" | "direct" | "lead";
  name: string | null;
  topic: string | null;
  /** At most 100 (the screen says 99+). */
  unread: number;
  muted: boolean;
  lastAt: string | null;
  people?: PersonLite[];
  lead?: { id: string; name: string; stage: string | null };
};
export type ChatList = {
  channels: ConvRow[];
  direct: ConvRow[];
  leads: ConvRow[];
  folds: { channels: boolean; direct: boolean; leads: boolean };
  unread: number;
};
export type GroupRef = { kind: "everyone" | "team" | "role"; id?: string | undefined };

/** A list as one Postgres array (drizzle spreads a bare array into a tuple); every id is checked as one before here. */
export const uuids = (ids: string[]): SQL => sql`${`{${ids.join(",")}}`}::uuid[]`;
export const bigints = (ids: number[]): SQL => sql`${`{${ids.join(",")}}`}::bigint[]`;

/**
 * Said to every open stream after the change commits; ids only, each stream reads the rest as its person. A lead's
 * thread carries its lead's owner, so only people who may see that lead hear it; a direct message says it is one, so
 * only there are read marks other people's business.
 */
export async function tell(
  req: FastifyRequest,
  e: { c: string; e: string; m?: number; u?: string },
): Promise<void> {
  const k = (
    await req.db.execute<{ kind: string; owner_id: string | null }>(sql`
      SELECT c.kind, l.owner_id FROM chat_conversations c LEFT JOIN leads l ON l.id = c.lead_id WHERE c.id = ${e.c}`)
  ).rows[0];
  const out =
    k?.kind === "lead" ? { ...e, lead: true, o: k.owner_id } : k?.kind === "direct" ? { ...e, d: true } : e;
  await req.db.execute(sql`SELECT pg_notify('lume_chat', ${JSON.stringify(out)})`);
}

const UNREAD_MAX = 100;
/**
 * The newest lead threads in the list; from how many places on they're found from the newest threads instead, and from
 * how many of those (tests lower them).
 */
export const tuning = { leadsShown: 50, manyPlaces: 2000, newestThreads: 20_000 };

type Row = {
  id: string;
  kind: ConvRow["kind"];
  name: string | null;
  topic: string | null;
  last_at: Date | null;
  muted: boolean;
  unread: number;
  lead_id: string | null;
  lead_name: string | null;
  stage: string | null;
};
/**
 * The person's conversations, each with its unread: the channels and direct messages they are in, and the newest lead
 * threads they follow (their own leads', and any they have written in) that have a message. Driven from their own rows,
 * never from every conversation there is; a count stops at 100 (one's own messages are read as they're sent).
 */
const rowsOf = async (req: FastifyRequest, fromPlaces = false): Promise<Row[]> => {
  const me = req.actor!.userId;
  // Few places: from them to their threads. Thousands: from the newest threads to their places, as the first fifty come
  // soon. Either way nothing is read of every thread there is. Compiling the statement would cost far more than running
  // it (row-level security makes Postgres think it long): not for this request.
  const places = (
    await req.db.execute<{ n: number }>(sql`
      SELECT set_config('jit', 'off', true), count(*)::int AS n FROM (SELECT 1 FROM chat_members WHERE user_id = ${me} AND via = 'lead' LIMIT ${tuning.manyPlaces}) AS p`)
  ).rows[0]!.n;
  const threads =
    fromPlaces || places < tuning.manyPlaces
      ? sql`SELECT c.id, c.kind, c.name, c.topic, c.last_at, c.last_message_id, cm.muted, cm.last_read_id, c.lead_id
          FROM chat_members cm JOIN chat_conversations c ON c.id = cm.conversation_id
          WHERE cm.user_id = ${me} AND cm.via = 'lead'
          ORDER BY c.last_at DESC LIMIT ${tuning.leadsShown}`
      : sql`SELECT c.id, c.kind, c.name, c.topic, c.last_at, c.last_message_id, cm.muted, cm.last_read_id, c.lead_id
          FROM (SELECT * FROM chat_conversations WHERE kind = 'lead' AND last_message_id IS NOT NULL
                ORDER BY last_at DESC LIMIT ${tuning.newestThreads}) c,
            LATERAL (SELECT m.muted, m.last_read_id FROM chat_members m
                     WHERE m.conversation_id = c.id AND m.user_id = ${me} OFFSET 0) cm
          ORDER BY c.last_at DESC LIMIT ${tuning.leadsShown}`;
  // A mark is compared as it is (no function around it): only then may the index be used under row-level security.
  const rows = (
    await req.db.execute<Row>(sql`
      WITH mine AS (
        SELECT c.id, c.kind, c.name, c.topic, c.last_at, c.last_message_id, cm.muted, cm.last_read_id,
          NULL::uuid AS lead_id
        FROM chat_members cm JOIN chat_conversations c ON c.id = cm.conversation_id
        WHERE cm.user_id = ${me} AND cm.via IN ('person', 'group') AND c.archived_at IS NULL
      ), threads AS (${threads}), every AS (SELECT * FROM mine UNION ALL SELECT * FROM threads)
      SELECT e.id, e.kind, e.name, e.topic, e.last_at, e.muted, l.id AS lead_id, l.name AS lead_name, s.name AS stage,
        CASE WHEN e.last_message_id > e.last_read_id THEN (SELECT count(*)::int FROM (
          SELECT 1 FROM chat_messages m
          WHERE m.conversation_id = e.id AND m.id > e.last_read_id AND m.deleted_at IS NULL
          LIMIT ${UNREAD_MAX}) AS u) ELSE 0 END AS unread
      FROM every e LEFT JOIN leads l ON l.id = e.lead_id LEFT JOIN stages s ON s.id = l.stage_id`)
  ).rows;
  // The newest threads held too few of theirs (all of them old): found from their places after all.
  const enough =
    fromPlaces ||
    places < tuning.manyPlaces ||
    rows.filter((r) => r.kind === "lead").length >= tuning.leadsShown;
  return enough ? rows : rowsOf(req, true);
};
const unreadOf = (rows: Row[]) => rows.filter((r) => !r.muted).reduce((t, r) => t + r.unread, 0);

/** The sidebar's number, and the conversations that never add to it. */
export const chatUnread = async (req: FastifyRequest) => {
  const rows = await rowsOf(req);
  return { unread: unreadOf(rows), muted: rows.filter((r) => r.muted).map((r) => r.id) };
};

async function viewsOf(req: FastifyRequest, rows: Row[]): Promise<Map<string, ConvRow>> {
  const me = req.actor!.userId;
  const directIds = rows.filter((r) => r.kind === "direct").map((r) => r.id);
  const people = directIds.length
    ? (
        await req.db.execute<{
          conversation_id: string;
          id: string;
          name: string;
          color: string | null;
          version: number;
          photo: boolean;
        }>(sql`
          SELECT m.conversation_id, u.id, u.name, u.avatar_color AS color, u.avatar_version AS version,
            EXISTS (SELECT 1 FROM user_avatars a WHERE a.user_id = u.id) AS photo
          FROM chat_members m JOIN users u ON u.id = m.user_id
          WHERE m.conversation_id = ANY(${uuids(directIds)}) AND m.user_id <> ${me}
          ORDER BY u.name`)
      ).rows
    : [];
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        kind: r.kind,
        name: r.name,
        topic: r.topic,
        unread: r.unread,
        muted: r.muted,
        lastAt: r.last_at ? new Date(r.last_at).toISOString() : null,
        ...(r.kind === "direct"
          ? {
              people: people
                .filter((p) => p.conversation_id === r.id)
                .map((p) => ({
                  id: p.id,
                  name: p.name,
                  avatar: { color: p.color, version: p.version, photo: p.photo },
                })),
            }
          : {}),
        ...(r.kind === "lead" && r.lead_id
          ? { lead: { id: r.lead_id, name: r.lead_name ?? "", stage: r.stage } }
          : {}),
      },
    ]),
  );
}

/** Everything the Chat screen's list needs. */
export async function chatList(req: FastifyRequest): Promise<ChatList> {
  const rows = await rowsOf(req);
  const views = await viewsOf(req, rows);
  const folds = (
    await req.db.execute<{ list: keyof ChatList["folds"]; folded: boolean }>(
      sql`SELECT list, folded FROM chat_list_folds WHERE user_id = ${req.actor!.userId}`,
    )
  ).rows;
  const newest = (a: Row, b: Row) =>
    (b.last_at ? +new Date(b.last_at) : 0) - (a.last_at ? +new Date(a.last_at) : 0);
  const of = (kind: ConvRow["kind"], by: (a: Row, b: Row) => number) =>
    rows
      .filter((r) => r.kind === kind)
      .sort(by)
      .map((r) => views.get(r.id)!);
  const folded = (list: keyof ChatList["folds"]) => folds.some((f) => f.list === list && f.folded);
  return {
    channels: of("channel", (a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    direct: of("direct", newest),
    leads: of("lead", newest),
    folds: { channels: folded("channels"), direct: folded("direct"), leads: folded("leads") },
    unread: unreadOf(rows),
  };
}

/** One conversation the person may read, in their list or not (a lead's thread opened from a link). */
export async function chatOne(req: FastifyRequest, id: string): Promise<ConvRow> {
  const me = req.actor!.userId;
  const row = (
    await req.db.execute<Row>(sql`
      SELECT c.id, c.kind, c.name, c.topic, c.last_at, coalesce(cm.muted, false) AS muted, 0 AS unread,
        l.id AS lead_id, l.name AS lead_name, s.name AS stage
      FROM chat_conversations c
      LEFT JOIN chat_members cm ON cm.conversation_id = c.id AND cm.user_id = ${me}
      LEFT JOIN leads l ON l.id = c.lead_id LEFT JOIN stages s ON s.id = l.stage_id
      WHERE c.id = ${id} AND c.archived_at IS NULL`)
  ).rows[0];
  if (!row) throw notFound("NOT_FOUND", "That conversation isn't there.");
  return (await viewsOf(req, [row])).get(id)!;
}

/** Names and photos for everyone who chats (people who left too: their messages stay). */
export async function chatPeople(
  req: FastifyRequest,
): Promise<{ people: (PersonLite & { active: boolean })[] }> {
  const rows = (
    await req.db.execute<{
      id: string;
      name: string;
      status: string;
      color: string | null;
      version: number;
      photo: boolean;
    }>(sql`
      SELECT u.id, u.name, u.status, u.avatar_color AS color, u.avatar_version AS version,
        EXISTS (SELECT 1 FROM user_avatars a WHERE a.user_id = u.id) AS photo
      FROM users u WHERE u.status <> 'invited' ORDER BY u.name`)
  ).rows;
  return {
    people: rows.map((r) => ({
      id: r.id,
      name: r.name,
      active: r.status === "active",
      avatar: { color: r.color, version: r.version, photo: r.photo },
    })),
  };
}

/** Active people among these ids (no one disabled, invited or gone). */
async function activeOf(req: FastifyRequest, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = (
    await req.db.execute<{ id: string }>(
      sql`SELECT id FROM users WHERE id = ANY(${uuids(ids)}) AND status = 'active'`,
    )
  ).rows;
  return new Set(rows.map((r) => r.id));
}

// ── Channels (chat.channels.manage) ─────────────────────────────────────────────────────────────────────────────────

/** Every channel, for whoever manages them: who is in each, and never what is said there. */
export async function channelsToManage(req: FastifyRequest) {
  const rows = (
    await req.db.execute<{
      id: string;
      name: string;
      topic: string | null;
      archived: boolean;
      people: string[];
      members: string;
      groups: { kind: GroupRef["kind"]; id?: string }[];
    }>(
      sql`SELECT id, name, topic, archived, people::text[] AS people, members, groups FROM lume_chat_channels()`,
    )
  ).rows;
  // Names alone, to choose from: who is in a team or role is its own screen's.
  const teams = (
    await req.db.execute<{ id: string; name: string }>(
      sql`SELECT id, name FROM teams WHERE deleted_at IS NULL ORDER BY name`,
    )
  ).rows;
  const roles = (
    await req.db.execute<{ id: string; name: string }>(
      sql`SELECT id, name FROM roles WHERE deleted_at IS NULL ORDER BY name`,
    )
  ).rows;
  return { channels: rows.map((r) => ({ ...r, members: Number(r.members) })), teams, roles };
}

/** Exactly these people by hand and these groups, in place: nobody who stays loses where they had read to. */
async function setPeople(
  req: FastifyRequest,
  id: string,
  people: string[],
  groups: GroupRef[],
): Promise<void> {
  for (const g of groups)
    if (g.kind !== "everyone" && !g.id) throw badRequest("GROUP", "Choose the team or role.");
  const refs = groups.map((g) => (g.kind === "everyone" ? { kind: g.kind } : { kind: g.kind, id: g.id! }));
  try {
    await req.db.execute(
      sql`SELECT lume_chat_set_people(${id}, ${uuids([...new Set(people)])}, ${JSON.stringify(refs)}::jsonb)`,
    );
  } catch (e) {
    if (pgCodeOf(e) === "P0002") throw notFound("NOT_FOUND", "That channel isn't there.");
    if (pgCodeOf(e) === "23503") throw badRequest("GROUP", "That team or role isn't there any more.");
    throw e;
  }
}

const nameOrRefuse = (raw: string): string => {
  const name = raw.trim();
  const problem = channelNameProblem(name);
  if (problem) throw badRequest("CHANNEL_NAME", problem);
  return name;
};
const taken = (e: unknown, name: string | null): never => {
  if (pgCodeOf(e) === "23505") throw conflict("CHANNEL_TAKEN", `There's already a channel called #${name}.`);
  throw e;
};

export async function makeChannel(
  req: FastifyRequest,
  body: {
    name: string;
    topic?: string | undefined;
    people?: string[] | undefined;
    groups?: GroupRef[] | undefined;
  },
): Promise<{ id: string }> {
  const name = nameOrRefuse(body.name);
  const id = newId();
  try {
    await req.db.execute(sql`
      INSERT INTO chat_conversations (id, kind, name, topic, created_by)
      VALUES (${id}, 'channel', ${name}, ${body.topic?.trim() || null}, ${req.actor!.userId})`);
  } catch (e) {
    taken(e, name);
  }
  // Whoever makes it is in it.
  await setPeople(req, id, [req.actor!.userId, ...(body.people ?? [])], body.groups ?? []);
  await audit(req, {
    action: "chat.channel.created",
    entityType: "chat_conversation",
    entityId: id,
    diff: { name },
  });
  await tell(req, { c: id, e: "members" });
  return { id };
}

export async function changeChannel(
  req: FastifyRequest,
  id: string,
  body: { name?: string | undefined; topic?: string | undefined; archived?: boolean | undefined },
): Promise<{ id: string }> {
  const name = body.name === undefined ? null : nameOrRefuse(body.name);
  let found = false;
  try {
    found = (
      await req.db.execute<{ ok: boolean }>(sql`
        SELECT lume_chat_change_channel(${id}, ${name}::citext, ${body.topic?.trim() || null},
          ${body.topic !== undefined}, ${body.archived ?? null}::boolean) AS ok`)
    ).rows[0]!.ok;
  } catch (e) {
    taken(e, name ?? "that");
  }
  if (!found) throw notFound("NOT_FOUND", "That channel isn't there.");
  await audit(req, {
    action: body.archived ? "chat.channel.archived" : "chat.channel.changed",
    entityType: "chat_conversation",
    entityId: id,
    diff: {
      ...(name ? { name } : {}),
      ...(body.topic !== undefined ? { topic: true } : {}),
      ...(body.archived === false ? { archived: false } : {}),
    },
  });
  await tell(req, { c: id, e: "changed" });
  return { id };
}

export async function setChannelMembers(
  req: FastifyRequest,
  id: string,
  body: { people: string[]; groups: GroupRef[] },
): Promise<{ id: string }> {
  await setPeople(req, id, body.people, body.groups);
  await audit(req, {
    action: "chat.members.changed",
    entityType: "chat_conversation",
    entityId: id,
    diff: { people: body.people.length, groups: body.groups.length },
  });
  await tell(req, { c: id, e: "members" });
  return { id };
}

// ── Direct messages and lead threads ────────────────────────────────────────────────────────────────────────────────

/** The direct message with exactly these people and the asker: made once, whoever starts it, even at once. */
export async function startDirect(req: FastifyRequest, people: string[]): Promise<{ id: string }> {
  const me = req.actor!.userId;
  const others = [...new Set(people)].filter((p) => p !== me);
  if (others.length === 0) throw badRequest("PEOPLE", "Choose who to message.");
  if (others.length + 1 > CHAT_LIMITS.directPeople)
    throw badRequest("PEOPLE", `A direct message can have at most ${CHAT_LIMITS.directPeople} people.`);
  const active = await activeOf(req, others);
  if (active.size !== others.length) throw badRequest("PEOPLE", "Someone here can't be messaged now.");
  return (await req.db.execute<{ id: string }>(sql`SELECT lume_chat_direct(${uuids(others)}) AS id`))
    .rows[0]!;
}

/** A lead's thread, made on first use (listed once it has a message). 404 when the lead isn't one they can see. */
export async function leadThread(req: FastifyRequest, leadId: string): Promise<{ id: string }> {
  const lead = (
    await req.db.execute<{ id: string }>(
      sql`SELECT id FROM leads WHERE id = ${leadId} AND deleted_at IS NULL`,
    )
  ).rows[0];
  if (!lead) throw notFound("NOT_FOUND", "That lead isn't there.");
  await req.db.execute(sql`
    INSERT INTO chat_conversations (id, kind, lead_id, created_by) VALUES (${newId()}, 'lead', ${leadId}, ${req.actor!.userId})
    ON CONFLICT DO NOTHING`);
  return (
    await req.db.execute<{ id: string }>(sql`SELECT id FROM chat_conversations WHERE lead_id = ${leadId}`)
  ).rows[0]!;
}

/** 404 unless the person may read the conversation (a channel's existence is never told). */
export async function convOf(
  req: FastifyRequest,
  id: string,
): Promise<{ id: string; kind: ConvRow["kind"] }> {
  const row = (
    await req.db.execute<{ id: string; kind: ConvRow["kind"] }>(
      sql`SELECT id, kind FROM chat_conversations WHERE id = ${id} AND archived_at IS NULL`,
    )
  ).rows[0];
  if (!row) throw notFound("NOT_FOUND", "That conversation isn't there.");
  return row;
}

export async function setMute(req: FastifyRequest, id: string, muted: boolean): Promise<void> {
  await convOf(req, id);
  // Only a place they have: muting a lead's thread one merely looked at isn't following it.
  await req.db.execute(
    sql`UPDATE chat_members SET muted = ${muted} WHERE conversation_id = ${id} AND user_id = ${req.actor!.userId}`,
  );
}

export async function setFold(
  req: FastifyRequest,
  list: keyof ChatList["folds"],
  folded: boolean,
): Promise<void> {
  await req.db.execute(sql`
    INSERT INTO chat_list_folds (user_id, list, folded) VALUES (${req.actor!.userId}, ${list}, ${folded})
    ON CONFLICT (user_id, list) DO UPDATE SET folded = ${folded}`);
}
