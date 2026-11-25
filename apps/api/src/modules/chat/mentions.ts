import { can, canOnRecord, CHAT_LIMITS, mentionsOf, type Actor } from "@lume/core";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { requestClient } from "../../db/context";
import { badRequest } from "../../http/errors";
import { loadActors } from "../../rbac/actor";
import { uuids } from "./conversations";
import { noteChat, type Notices } from "./notices";

/**
 * Who a message names (plan 2026-11-25-team-chat-2b, Task 2). Only people who may read the conversation are kept and
 * told; the sender hears whom they named that wasn't. A lead's thread is asked of each of them, as they are now.
 */
export type Named = { people: string[]; teams: string[]; channel: boolean };
const NONE: Named = { people: [], teams: [], channel: false };
/** In a lead's thread each person is looked at as they are: named people first, then their teams', to this many. */
const LEAD_MAX = 1000;

/**
 * Whom these words name; refused in words when it's more than may be named, or everyone by someone who may not. Of an
 * edit, only what its old words didn't name already: a typo in an old message is always theirs to put right.
 */
export async function namedIn(
  req: FastifyRequest,
  conv: { id: string; kind: string },
  body: string,
  old = "",
): Promise<Named> {
  if (!body.includes("<@")) return NONE;
  const named = mentionsOf(body);
  const was = mentionsOf(old);
  const fresh =
    named.people.filter((p) => !was.people.includes(p)).length +
    named.teams.filter((t) => !was.teams.includes(t)).length;
  if (fresh > CHAT_LIMITS.mentions)
    throw badRequest("MENTIONS", `A message can name at most ${CHAT_LIMITS.mentions} people and teams.`);
  if (named.channel && !was.channel && conv.kind === "channel" && !can(req.actor!, "chat.channels.manage")) {
    const n = (
      await req.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM (SELECT 1 FROM chat_members WHERE conversation_id = ${conv.id} LIMIT ${CHAT_LIMITS.channelWide + 1}) AS m`,
      )
    ).rows[0]!.n;
    if (n > CHAT_LIMITS.channelWide)
      throw badRequest(
        "MENTIONS",
        `In a channel of more than ${CHAT_LIMITS.channelWide} people, only someone who manages channels can name everyone.`,
      );
  }
  return named;
}

/** Whom these words name who may read the conversation (never oneself), found before a send holds it. */
export async function readersOf(
  req: FastifyRequest,
  conv: { id: string; kind: string },
  named: Named,
): Promise<Set<string>> {
  if (!named.people.length && !named.teams.length && !named.channel) return new Set();
  const me = req.actor!.userId;
  if (conv.kind !== "lead") {
    const rows = (
      await req.db.execute<{ user_id: string }>(sql`
        SELECT m.user_id FROM chat_members m JOIN users u ON u.id = m.user_id AND u.status = 'active'
        WHERE m.conversation_id = ${conv.id} AND m.user_id <> ${me}
          AND (${named.channel} OR m.user_id = ANY(${uuids(named.people)})
            OR EXISTS (SELECT 1 FROM team_members t JOIN teams g ON g.id = t.team_id AND g.deleted_at IS NULL
                       WHERE t.team_id = ANY(${uuids(named.teams)}) AND t.user_id = m.user_id))`)
    ).rows;
    return new Set(rows.map((r) => r.user_id));
  }
  // A lead's thread: whoever has a place in it, for everyone; and their teams' people.
  const rest = (
    await req.db.execute<{ user_id: string }>(sql`
      SELECT DISTINCT u.id AS user_id FROM users u
      WHERE u.status = 'active' AND (
        EXISTS (SELECT 1 FROM team_members t JOIN teams g ON g.id = t.team_id AND g.deleted_at IS NULL
                WHERE t.team_id = ANY(${uuids(named.teams)}) AND t.user_id = u.id)
        OR (${named.channel} AND EXISTS (
              SELECT 1 FROM chat_members m WHERE m.conversation_id = ${conv.id} AND m.user_id = u.id)))
      ORDER BY u.id LIMIT ${LEAD_MAX}`)
  ).rows.map((r) => r.user_id);
  const owner = (
    await req.db.execute<{ owner_id: string | null }>(
      sql`SELECT l.owner_id FROM chat_conversations c JOIN leads l ON l.id = c.lead_id WHERE c.id = ${conv.id}`,
    )
  ).rows[0];
  const ids = [...new Set([...named.people, ...rest])].filter((id) => id !== me).slice(0, LEAD_MAX);
  const out = new Set<string>();
  for (const who of (await loadActors(requestClient(req), ids)).values())
    if (can(who as Actor, "chat.use") && canOnRecord(who as Actor, "leads.view", owner?.owner_id ?? null))
      out.add(who.userId);
  return out;
}

/**
 * Keeps whom a message names, and tells those it names for the first time once it's kept (an edit that names someone
 * new, or by name after all, tells them; one that takes a name away un-tells nobody). Whoever is named and can't read
 * it, for the sender.
 */
export async function keepMentions(
  req: FastifyRequest,
  notices: Notices,
  conv: { id: string; kind: string },
  m: { id: number; root: number },
  named: Named,
  readers: ReadonlySet<string>,
): Promise<string[]> {
  const me = req.actor!.userId;
  const byName = new Set(named.people);
  const told = [...readers];
  if (told.length) {
    const kept = (
      await req.db.execute<{ user_id: string }>(sql`
        INSERT INTO chat_mentions (message_id, user_id, by_name, conversation_id, root)
        SELECT ${m.id}, u, u = ANY(${uuids(told.filter((u) => byName.has(u)))}), ${conv.id}, ${m.root}
        FROM unnest(${uuids(told)}) AS u
        ON CONFLICT (message_id, user_id) DO UPDATE SET by_name = true, seen = false
        WHERE EXCLUDED.by_name AND NOT chat_mentions.by_name RETURNING user_id`)
    ).rows;
    for (const k of kept)
      noteChat(req, notices, { userId: k.user_id, conv: conv.id, kind: "chat_mention", root: m.root });
  }
  return named.people.filter((p) => p !== me && !readers.has(p));
}

/** Whom a message named, for a notice that may have nothing left to say (it was deleted). */
export async function mentionedIn(req: FastifyRequest, mid: number): Promise<string[]> {
  return (
    await req.db.execute<{ user_id: string }>(
      sql`SELECT user_id FROM chat_mentions WHERE message_id = ${mid}`,
    )
  ).rows.map((r) => r.user_id);
}

/** Whom the person may name in a conversation: its members (anyone, about a lead: each is checked as it's sent). */
export async function mentionable(req: FastifyRequest, conv: { id: string; kind: string }) {
  const members =
    conv.kind === "lead"
      ? null
      : (
          await req.db.execute<{ user_id: string }>(sql`
            SELECT m.user_id FROM chat_members m JOIN users u ON u.id = m.user_id AND u.status = 'active'
            WHERE m.conversation_id = ${conv.id} LIMIT 5000`)
        ).rows.map((r) => r.user_id);
  const teams = (
    await req.db.execute<{ id: string; name: string }>(
      sql`SELECT id, name FROM teams WHERE deleted_at IS NULL ORDER BY name LIMIT 500`,
    )
  ).rows;
  return {
    members,
    teams,
    everyone:
      conv.kind !== "channel" ||
      can(req.actor!, "chat.channels.manage") ||
      (members?.length ?? 0) <= CHAT_LIMITS.channelWide,
  };
}
