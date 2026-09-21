import type pg from "pg";
import { loadActor, type ActorRecord } from "./actor";

const MAX_ENTRIES = 5000;

/**
 * Report §7.1: permission changes take effect on the next request. Entries live at most `ttlMs` and are
 * dropped the moment a role/user/team change NOTIFYs `lume_rbac` (see startRbacListener).
 */
export class ActorCache {
  private readonly entries = new Map<string, { at: number; value: ActorRecord | null }>();
  constructor(
    private readonly pool: pg.Pool,
    private readonly ttlMs = 30_000,
    private readonly now = () => Date.now(),
  ) {}

  async get(userId: string): Promise<ActorRecord | null> {
    const hit = this.entries.get(userId);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const value = await loadActor(this.pool, userId);
    this.entries.delete(userId); // re-insert so Map order approximates least-recently-loaded
    this.entries.set(userId, { at: this.now(), value });
    if (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    return value;
  }

  /** One user, or everyone (role and team edits affect many people at once). */
  invalidate(userId?: string): void {
    if (userId) this.entries.delete(userId);
    else this.entries.clear();
  }
}

/**
 * One dedicated connection LISTENs on `lume_rbac`; the payload is a user id, or empty for "everyone".
 * If that connection drops, the whole cache is cleared and the listener reconnects.
 */
export async function startRbacListener(
  pool: pg.Pool,
  cache: ActorCache,
  onEvent?: (payload: string) => void,
): Promise<() => Promise<void>> {
  let client: pg.PoolClient | null = null;
  let stopped = false;
  let retry: NodeJS.Timeout | undefined;

  const connect = async (): Promise<void> => {
    const c = await pool.connect();
    c.on("notification", (msg) => {
      if (msg.channel !== "lume_rbac") return;
      cache.invalidate(msg.payload || undefined);
      onEvent?.(msg.payload ?? "");
    });
    c.on("error", () => {
      if (client === c) client = null;
      c.release(true);
      cache.invalidate();
      if (!stopped) retry = setTimeout(() => void connect().catch(() => undefined), 1000);
    });
    await c.query("LISTEN lume_rbac");
    client = c;
  };
  await connect();

  return async () => {
    stopped = true;
    clearTimeout(retry);
    const c = client;
    client = null;
    if (!c) return;
    await c.query("UNLISTEN lume_rbac").catch(() => undefined);
    c.release();
  };
}
