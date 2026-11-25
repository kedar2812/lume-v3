import { and, desc, inArray, isNull, sql } from "drizzle-orm";
import type { ServerResponse } from "node:http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { can, canOnRecord } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { onSessionsRevoked } from "../../auth/sessions";
import {
  alertIdOf,
  countUnread,
  missedSince,
  readSignal,
  said,
  startHub,
  streamWriter,
  type NotificationView,
  type WhatsAppEvent,
} from "./hub";
import { leadsDelay, leadsEveryMs } from "./budget";
import { createChatLive } from "../chat/live";

const N = schema.notifications;
const self = { permission: "auth.self" as const };
const HEARTBEAT_MS = 25_000;
/** At most one "leads changed" per stream in this long: a burst (an import) becomes one or two (4B). */
/** How far before the last id a replay starts (ids can commit out of order), and how many ids a stream remembers. */
const OVERLAP = 50;
const SENT_MAX = 2000;

const unreadOf = async (req: FastifyRequest) =>
  (
    await req.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM notifications WHERE read_at IS NULL`,
    )
  ).rows[0]!.n;

/** Phase 3 spec §7: a person's notifications, and the live stream of new ones. */
export async function notificationRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const hub = await startHub(d.pool);
  // Open streams would hold the server open for ever (a heartbeat every 25 s): end them first, so an update
  // restarts cleanly and the pools close (3A final review, Important 6).
  const open = new Set<ServerResponse>();
  app.addHook("preClose", async () => {
    for (const res of open) res.end();
    open.clear();
  });
  // Team Chat, live (plan 2026-11-24-team-chat-2a, Task 6): on the same hub, so one stream carries everything.
  const chat = createChatLive(d.pool, hub);
  app.addHook("onClose", async () => {
    chat.stop();
    await hub.stop();
  });
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** Who is online among the people the asker shares a conversation with (Team Chat's dots). */
  r.get("/api/v1/chat/online", { config: { permission: "chat.use" } }, async (req) => {
    const on = `{${chat.online().join(",")}}`;
    const people = (
      await req.db.execute<{ id: string }>(sql`SELECT lume_chat_share(${on}::uuid[]) AS id`)
    ).rows.map((x) => x.id);
    return { online: people };
  });

  // Row-level security keeps these to the caller's own (0021_follow_ups.sql).
  r.get("/api/v1/notifications", { config: self }, async (req) => {
    const rows = await req.db.select().from(N).where(isNull(N.clearedAt)).orderBy(desc(N.id)).limit(50);
    return {
      items: rows.map((n): NotificationView => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        leadId: n.leadId,
        taskId: n.taskId,
        createdAt: n.createdAt.toISOString(),
        read: n.readAt !== null,
        alertId: alertIdOf(n.kind, n.data),
      })),
      unread: await unreadOf(req),
    };
  });
  r.post(
    "/api/v1/notifications/read",
    {
      config: self,
      schema: {
        body: z.union([
          z.object({ ids: z.array(z.number().int().min(1)).min(1).max(200) }).strict(),
          z.object({ all: z.literal(true) }).strict(),
        ]),
      },
    },
    async (req) => {
      await req.db
        .update(N)
        .set({ readAt: new Date() })
        .where(and(isNull(N.readAt), "ids" in req.body ? inArray(N.id, req.body.ids) : sql`true`));
      // Every other tab and device of theirs hears the new count (on commit).
      await req.db.execute(sql`SELECT pg_notify('lume_notifications', ${readSignal(req.actor!.userId)})`);
      return { unread: await unreadOf(req) };
    },
  );

  // "Clear read" (owner, 2026-10-05): every read notification leaves the list; Undo brings exactly those back.
  r.post("/api/v1/notifications/clear-read", { config: self }, async (req) => {
    const rows = await req.db
      .update(N)
      .set({ clearedAt: new Date() })
      .where(and(sql`${N.readAt} IS NOT NULL`, isNull(N.clearedAt)))
      .returning({ id: N.id });
    return { cleared: rows.map((r) => r.id) };
  });
  r.post(
    "/api/v1/notifications/clear-read/undo",
    {
      config: self,
      schema: { body: z.object({ ids: z.array(z.number().int().min(1)).min(1).max(1000) }).strict() },
    },
    async (req) => {
      const rows = await req.db
        .update(N)
        .set({ clearedAt: null })
        .where(inArray(N.id, req.body.ids))
        .returning({ id: N.id });
      return { restored: rows.length };
    },
  );

  /**
   * Server-Sent Events (spec §3 Live updates). No request transaction: a stream stays open for hours. What
   * the browser missed (Last-Event-ID) is replayed first; anything arriving meanwhile waits its turn, and
   * nothing is sent twice.
   */
  r.get(
    "/api/v1/stream",
    {
      config: { ...self, db: false },
      schema: { querystring: z.object({ after: z.coerce.number().int().min(0).optional() }) },
    },
    async (req, reply) => {
      const userId = req.actor!.userId;
      // Where to resume: the browser's own Last-Event-ID, or ?after= when LUME reconnects by hand after
      // the browser gave up (an API restart answers 502 for a moment; 3A final review, Important 4).
      const lastSeen = Number(req.headers["last-event-id"]) || req.query.after || 0;
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const stream = streamWriter(res);
      const write = stream.write;
      write("retry: 3000\n: connected\n\n");
      open.add(res);
      // The session this stream was opened with ends (signed out, revoked): so does the stream.
      const sessionId = req.session?.id;
      const offRevoked = onSessionsRevoked((r) => {
        const mine =
          "sessionId" in r ? r.sessionId === sessionId : r.userId === userId && r.exceptId !== sessionId;
        if (mine) stream.stop();
      });
      // Each id once, whatever order they commit in (Important 3). Bounded: the oldest are forgotten first.
      const sent = new Set<number>();
      let high = lastSeen;
      const send = (n: NotificationView) => {
        if (sent.has(n.id)) return;
        sent.add(n.id);
        if (sent.size > SENT_MAX) sent.delete(sent.values().next().value!);
        high = Math.max(high, n.id);
        write(`id: ${n.id}\nevent: notification\ndata: ${JSON.stringify(n)}\n\n`);
      };
      let replaying = true;
      const waiting: NotificationView[] = [];
      const replay = async (from: number) => {
        for (const n of await missedSince(d.pool, userId, Math.max(0, from - OVERLAP))) send(n);
      };
      // The bell's number (2026-11-15): said as the stream opens and whenever something is read, never counted.
      const sayUnread = (unread: number) => write(`event: unread\ndata: ${JSON.stringify({ unread })}\n\n`);
      const offUnread = hub.subscribeUnread(userId, sayUnread);
      const unsubscribe = hub.subscribe(
        userId,
        (n) => (replaying ? waiting.push(n) : send(n)),
        () =>
          void replay(high)
            .then(async () => sayUnread(await countUnread(d.pool, userId)))
            .catch(() => undefined),
      );
      const beat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
      // Leads changed (4B): the first at once, then at most one trailing per window. No id, so the
      // browser's Last-Event-ID stays the notifications'; no data, so nothing about whose or which.
      let lastLeads = 0;
      let trailing: NodeJS.Timeout | undefined;
      const sayLeads = () => {
        lastLeads = Date.now();
        write("event: leads\ndata: {}\n\n");
      };
      // Only to people who see leads at all: anyone else has nothing to recount (4B minor).
      const seesLeads = can(req.actor!, "leads.view");
      const offLeads = hub.onLeads(() => {
        if (!seesLeads) return;
        // The refresh budget (budget.ts): within 3 s for a small team, less often and spread out for a big one, so a
        // thousand browsers never re-read their counts in the same instant.
        const streams = hub.streams();
        const wait = lastLeads + leadsEveryMs(streams) - Date.now();
        trailing ??= setTimeout(() => {
          trailing = undefined;
          sayLeads();
        }, leadsDelay({ streams, wait }));
      });
      // LUME AI's runs (Autopilot A2): each change as its run, lead and kind (no id, no words); the screen reads the
      // rest under its own access.
      // A run on a lead: only people who may see that lead (a run with no lead says nothing of anyone's).
      const offAutopilot = hub.onAutopilot((e) => {
        if (!seesLeads || (e.lead && !canOnRecord(req.actor!, "leads.view", e.of ?? null))) return;
        write(`event: autopilot\ndata: ${JSON.stringify({ run: e.run, lead: e.lead, kind: e.kind })}\n\n`);
      });
      // WhatsApp (2026-11-01): a message in, out or a tick, as its lead and kind (and, in, whose lead); the chat and the
      // owner's notice read the rest under their own access.
      // Only about leads this person may see: whose lead it is decides, as it does everywhere else.
      const reaches = (e: WhatsAppEvent) => seesLeads && canOnRecord(req.actor!, "leads.view", e.of);
      const offWhatsApp = hub.onWhatsApp((e) => {
        if (reaches(e))
          write(`event: whatsapp
data: ${JSON.stringify(said(e))}

`);
      });
      // Instagram (NEW_FEATURES_PLAN §4.6): as WhatsApp's, its own event.
      const offInstagram = hub.onInstagram((e) => {
        if (reaches(e))
          write(`event: instagram
data: ${JSON.stringify(said(e))}

`);
      });
      // Live sheets (2026-11-14): a sheet's progress or status, as its id and kind, for people who make them.
      // Team Chat: each event as its conversation and kind, to the people it's for; who comes online and goes.
      const offChat = chat.subscribe({
        userId,
        actor: req.actor!,
        say: (name, data) =>
          write(`event: ${name}
data: ${JSON.stringify(data)}

`),
      });
      const makesSheets = can(req.actor!, "leads.live_sheets");
      const offLiveSheet = hub.onLiveSheet((e) => {
        if (makesSheets) write(`event: live_sheet\ndata: ${JSON.stringify(e)}\n\n`);
      });
      req.raw.on("close", () => {
        offChat();
        offLiveSheet();
        offWhatsApp();
        offInstagram();
        offUnread();
        offAutopilot();
        offRevoked();
        clearInterval(beat);
        clearTimeout(trailing);
        offLeads();
        unsubscribe();
        open.delete(res);
      });
      try {
        if (lastSeen) await replay(lastSeen);
      } finally {
        replaying = false;
        for (const n of waiting.sort((a, b) => a.id - b.id)) send(n);
      }
      // After what was missed: the true count, so a tab that slept while things were read elsewhere is put right.
      sayUnread(await countUnread(d.pool, userId).catch(() => 0));
    },
  );
}
