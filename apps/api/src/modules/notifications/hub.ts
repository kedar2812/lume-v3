import type pg from "pg";

export type NotificationView = {
  id: number;
  kind: string;
  title: string;
  body: string | null;
  leadId: string | null;
  taskId: string | null;
  createdAt: string;
  read: boolean;
};
type Row = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  lead_id: string | null;
  task_id: string | null;
  created_at: Date;
  read_at: Date | null;
};
export const toView = (r: Row): NotificationView => ({
  id: Number(r.id),
  kind: r.kind,
  title: r.title,
  body: r.body,
  leadId: r.lead_id,
  taskId: r.task_id,
  createdAt: r.created_at.toISOString(),
  read: r.read_at !== null,
});

/** Read a person's own notifications, as them (they're only ever theirs: row-level security). */
export async function readAs<T>(
  pool: pg.Pool,
  userId: string,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true)", [userId]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** What a reconnecting stream missed: the person's notifications after the last one it had, oldest first. */
/**
 * What a reconnecting stream missed: the person's notifications after `afterId`, oldest first, all of them
 * (a page at a time, up to 1,000). Callers start a little before the last id they had: ids are handed out
 * when a row is written, not when it commits, so a slower writer's lower id can arrive after a higher one
 * (3A final review, Important 3). The stream drops the ones it already sent.
 */
export const missedSince = (pool: pg.Pool, userId: string, afterId: number) =>
  readAs(pool, userId, async (c) => {
    const out: NotificationView[] = [];
    let after = afterId;
    for (let page = 0; page < 5; page++) {
      const { rows } = await c.query<Row>(
        "SELECT id, kind, title, body, lead_id, task_id, created_at, read_at FROM notifications WHERE id > $1 ORDER BY id LIMIT 200",
        [after],
      );
      out.push(...rows.map(toView));
      if (rows.length < 200) break;
      after = Number(rows.at(-1)!.id);
    }
    return out;
  });

/**
 * One `LISTEN lume_notifications` for the whole API (Phase 3 spec §3 Live updates). Each payload names a
 * person and a notification; it's read as that person and sent to their open streams only. The listening
 * connection comes back on its own after an error, as the RBAC listener's does.
 */
export async function startHub(pool: pg.Pool) {
  const subscribers = new Map<string, Set<(n: NotificationView) => void>>();
  /** Told when the listener comes back after losing its connection: whatever arrived meanwhile wasn't heard. */
  const resyncs = new Set<() => void>();
  let failures = 0;
  let client: pg.PoolClient | null = null;
  let stopped = false;
  let retry: NodeJS.Timeout | undefined;

  const deliver = async (payload: string) => {
    let msg: { u?: string; n?: number };
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    const subs = msg.u ? subscribers.get(msg.u) : undefined;
    if (!subs?.size || !msg.u || !msg.n) return;
    const [row] = await readAs(pool, msg.u, async (c) =>
      (
        await c.query<Row>(
          "SELECT id, kind, title, body, lead_id, task_id, created_at, read_at FROM notifications WHERE id = $1",
          [msg.n],
        )
      ).rows.map(toView),
    );
    if (row) for (const send of subs) send(row);
  };
  /** Keeps trying, backing off to 30 s, until it listens again (3A final review, Important 5). */
  const again = () => {
    if (stopped) return;
    const wait = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
    retry = setTimeout(
      () =>
        void connect().then(
          () => {
            failures = 0;
            for (const r of resyncs) r();
          },
          () => again(),
        ),
      wait,
    );
  };
  const connect = async (): Promise<void> => {
    const c = await pool.connect();
    c.on("notification", (m) => {
      if (m.channel === "lume_notifications") void deliver(m.payload ?? "").catch(() => undefined);
    });
    c.on("error", () => {
      if (client === c) client = null;
      c.release(true);
      again();
    });
    await c.query("LISTEN lume_notifications");
    client = c;
  };
  await connect();

  return {
    subscribe(userId: string, send: (n: NotificationView) => void, resync?: () => void): () => void {
      let set = subscribers.get(userId);
      if (!set) subscribers.set(userId, (set = new Set()));
      set.add(send);
      if (resync) resyncs.add(resync);
      return () => {
        set.delete(send);
        if (!set.size) subscribers.delete(userId);
        if (resync) resyncs.delete(resync);
      };
    },
    async stop() {
      stopped = true;
      clearTimeout(retry);
      const c = client;
      client = null;
      if (c) {
        await c.query("UNLISTEN lume_notifications").catch(() => undefined);
        c.release();
      }
    },
  };
}
export type Hub = Awaited<ReturnType<typeof startHub>>;
