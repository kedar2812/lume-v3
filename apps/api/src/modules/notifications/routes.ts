import { and, desc, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { missedSince, startHub, type NotificationView } from "./hub";

const N = schema.notifications;
const self = { permission: "auth.self" as const };
const HEARTBEAT_MS = 25_000;

const unreadOf = async (req: FastifyRequest) =>
  (
    await req.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM notifications WHERE read_at IS NULL`,
    )
  ).rows[0]!.n;

/** Phase 3 spec §7: a person's notifications, and the live stream of new ones. */
export async function notificationRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const hub = await startHub(d.pool);
  app.addHook("onClose", async () => hub.stop());
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Row-level security keeps these to the caller's own (0021_follow_ups.sql).
  r.get("/api/v1/notifications", { config: self }, async (req) => {
    const rows = await req.db.select().from(N).orderBy(desc(N.id)).limit(50);
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

  /**
   * Server-Sent Events (spec §3 Live updates). No request transaction: a stream stays open for hours. What
   * the browser missed (Last-Event-ID) is replayed first; anything arriving meanwhile waits its turn, and
   * nothing is sent twice.
   */
  r.get("/api/v1/stream", { config: { ...self, db: false } }, async (req, reply) => {
    const userId = req.actor!.userId;
    const lastSeen = Number(req.headers["last-event-id"]) || 0;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n: connected\n\n");
    let high = lastSeen;
    let replaying = true;
    const waiting: NotificationView[] = [];
    const send = (n: NotificationView) => {
      if (n.id <= high) return;
      high = n.id;
      res.write(`id: ${n.id}\nevent: notification\ndata: ${JSON.stringify(n)}\n\n`);
    };
    const unsubscribe = hub.subscribe(userId, (n) => (replaying ? waiting.push(n) : send(n)));
    const beat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    req.raw.on("close", () => {
      clearInterval(beat);
      unsubscribe();
    });
    try {
      if (lastSeen) for (const n of await missedSince(d.pool, userId, lastSeen)) send(n);
    } finally {
      replaying = false;
      for (const n of waiting.sort((a, b) => a.id - b.id)) send(n);
    }
  });
}
