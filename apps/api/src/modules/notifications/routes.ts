import { and, desc, inArray, isNull, sql } from "drizzle-orm";
import type { ServerResponse } from "node:http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { can } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { onSessionsRevoked } from "../../auth/sessions";
import { alertIdOf, missedSince, startHub, streamWriter, type NotificationView } from "./hub";

const N = schema.notifications;
const self = { permission: "auth.self" as const };
const HEARTBEAT_MS = 25_000;
/** At most one "leads changed" per stream in this long: a burst (an import) becomes one or two (4B). */
const LEADS_EVERY_MS = 3000;
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
  app.addHook("onClose", async () => hub.stop());
  const r = app.withTypeProvider<ZodTypeProvider>();

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
      const unsubscribe = hub.subscribe(
        userId,
        (n) => (replaying ? waiting.push(n) : send(n)),
        () => void replay(high).catch(() => undefined),
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
        const wait = lastLeads + LEADS_EVERY_MS - Date.now();
        if (wait <= 0) return sayLeads();
        trailing ??= setTimeout(() => {
          trailing = undefined;
          sayLeads();
        }, wait);
      });
      req.raw.on("close", () => {
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
    },
  );
}
