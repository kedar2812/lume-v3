import { can, canOnRecord, CHAT_LIMITS, type Actor } from "@lume/core";
import type pg from "pg";
import type { ChatEvent, Hub } from "../notifications/hub";

/**
 * Team Chat, live (plan 2026-11-24-team-chat-2a, Task 6). One listener for the whole API decides who hears each
 * event: a channel's or direct message's members (cached per conversation, forgotten when they change), or for a lead's
 * thread whoever may see that lead (its owner rides on the event, as WhatsApp's do). Events carry ids and a kind; each
 * screen reads the rest under its own access. Typing and who's online are never written anywhere.
 */
/**
 * How far apart each screen's reads should be when this many hear an event (the owner's thousand people): a small team
 * reads at once; a big one spreads over a few seconds, so one message never becomes a burst.
 */
const ALL_AT_ONCE = 20;
const PER_LISTENER_MS = 10;
const SPACING_MAX_MS = 4000;
export const spacingMs = (heard: number): number =>
  heard <= ALL_AT_ONCE ? 0 : Math.min(SPACING_MAX_MS, heard * PER_LISTENER_MS);

type Listener = { userId: string; actor: Actor; say: (name: "chat" | "presence", data: object) => void };

export function createChatLive(pool: pg.Pool, hub: Hub) {
  const listeners = new Set<Listener>();
  const members = new Map<string, Promise<Set<string>>>();
  const load = async (c: string) =>
    new Set(
      (await pool.query<{ ids: string[] }>("SELECT lume_chat_member_ids($1) AS ids", [c])).rows[0]?.ids ?? [],
    );
  const followersOf = async (root: number) =>
    new Set(
      (await pool.query<{ ids: string[] }>("SELECT lume_chat_thread_followers($1) AS ids", [root])).rows[0]
        ?.ids ?? [],
    );
  const membersOf = (c: string) => {
    let p = members.get(c);
    if (!p) {
      p = load(c);
      members.set(c, p);
      // A failed read is tried again next time, never kept.
      p.catch(() => members.delete(c));
    }
    return p;
  };
  const chats = (l: Listener) => can(l.actor, "chat.use");

  const heard = async (e: ChatEvent) => {
    if (e.e === "presence") {
      for (const l of listeners) if (chats(l) && l.userId !== e.u) l.say("presence", { u: e.u, on: e.on });
      return;
    }
    if (e.e === "members" && !e.c) {
      // Teams or roles changed: forget every channel's members, and every list reads itself again.
      members.clear();
      for (const l of listeners) if (chats(l)) l.say("chat", { e: "members" });
      return;
    }
    const c = e.c!;
    let hears: (l: Listener) => boolean;
    // Where someone has read to is theirs alone (their other tabs), but in a direct message.
    // A thread's mark is theirs alone even there.
    if ((e.e === "read" || e.e === "delivered") && (!e.d || e.t !== undefined))
      hears = (l) => l.userId === e.u;
    else if (e.lead) hears = (l) => chats(l) && canOnRecord(l.actor, "leads.view", e.o ?? null);
    else {
      if (e.e === "members") members.delete(c);
      const now = await membersOf(c);
      hears = (l) => chats(l) && now.has(l.userId);
      // Someone just taken out (known or not) is told only that their list may have changed, never of which channel.
      if (e.e === "members")
        for (const l of listeners) if (chats(l) && !now.has(l.userId)) l.say("chat", { e: "members" });
    }
    const to = [...listeners].filter((l) => hears(l) && !(e.e === "typing" && l.userId === e.u));
    const w = spacingMs(to.length);
    const data = {
      c,
      e: e.e,
      ...(e.m !== undefined ? { m: e.m } : {}),
      ...(e.u ? { u: e.u } : {}),
      ...(e.t !== undefined ? { t: e.t } : {}),
      ...(e.d ? { d: true } : {}),
      ...(e.lead ? { l: true } : {}),
      ...(w ? { w } : {}),
    };
    // A thread's reply counts for those who follow it, and for no one else.
    const follow =
      e.e === "reply" && e.t !== undefined && to.length ? await followersOf(e.t) : new Set<string>();
    for (const l of to) l.say("chat", follow.has(l.userId) ? { ...data, f: true } : data);
  };
  const off = hub.onChat((e) => void heard(e).catch(() => undefined));
  // The listener lost its connection for a while: whoever joined or left meanwhile is unknown, and so is every
  // message said. Each tab catches up by itself.
  const offResync = hub.onResync(() => {
    members.clear();
    for (const l of listeners) if (chats(l)) l.say("chat", { c: "*", e: "reconnected" });
  });

  const say = (userId: string, on: boolean) =>
    pool
      .query("SELECT pg_notify('lume_chat', $1)", [JSON.stringify({ e: "presence", u: userId, on })])
      .catch(() => undefined);
  const count = (userId: string) => [...listeners].filter((l) => l.userId === userId).length;

  return {
    /** A stream's person hears what's theirs; their first stream says they're online, their last that they've gone. */
    subscribe(l: Listener): () => void {
      const first = count(l.userId) === 0;
      listeners.add(l);
      if (first && chats(l)) void say(l.userId, true);
      return () => {
        listeners.delete(l);
        if (count(l.userId) === 0 && chats(l)) void say(l.userId, false);
      };
    },
    /** Everyone who chats with a stream open here. */
    online(): string[] {
      return [...new Set([...listeners].filter(chats).map((l) => l.userId))];
    },
    stop: () => {
      off();
      offResync();
    },
  };
}
export type ChatLive = ReturnType<typeof createChatLive>;

/** "Typing" at most once per person, conversation and window (the browser sends it while keys are pressed). */
const typedAt = new Map<string, number>();
export function typingAllowed(userId: string, conv: string, now = Date.now()): boolean {
  const key = `${userId}:${conv}`;
  const last = typedAt.get(key) ?? 0;
  if (now - last < CHAT_LIMITS.typingEveryMs) return false;
  typedAt.set(key, now);
  // Bounded: entries older than a window are forgotten as new ones come.
  if (typedAt.size > 10_000)
    for (const [k, t] of typedAt) if (now - t > CHAT_LIMITS.typingEveryMs) typedAt.delete(k);
  return true;
}
