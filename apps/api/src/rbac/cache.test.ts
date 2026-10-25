import type pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActorRecord } from "./actor";

/**
 * Permission changes take effect on the next request (report §7.1). A load that began before a change landed must
 * never be kept: kept, the person held the removed access for the cache's 30 seconds (review 2026-10-25).
 */
const loads: { userId: string; resolve(v: ActorRecord | null): void }[] = [];
vi.mock("./actor", () => ({
  loadActor: (_pool: unknown, userId: string) =>
    new Promise<ActorRecord | null>((resolve) => loads.push({ userId, resolve })),
}));
const { ActorCache } = await import("./cache");

const actor = (tag: string) => ({ userId: "u1", tag }) as unknown as ActorRecord;
const pool = {} as pg.Pool;
beforeEach(() => {
  loads.length = 0;
});

describe("the actor cache", () => {
  it("a load that began before this person's change is used once, never kept", async () => {
    const cache = new ActorCache(pool);
    const first = cache.get("u1");
    // The role is taken away while the load (which read the old roles) is still on its way.
    cache.invalidate("u1");
    loads[0]!.resolve(actor("old"));
    expect(await first).toEqual(actor("old"));
    // The next request loads again, and sees the change.
    const next = cache.get("u1");
    expect(loads).toHaveLength(2);
    loads[1]!.resolve(actor("new"));
    expect(await next).toEqual(actor("new"));
  });

  it("the same when everyone's access changed at once (a role or a team edited)", async () => {
    const cache = new ActorCache(pool);
    const first = cache.get("u1");
    cache.invalidate();
    loads[0]!.resolve(actor("old"));
    await first;
    void cache.get("u1");
    expect(loads).toHaveLength(2);
  });

  it("a load with no change on the way is kept, as before", async () => {
    const cache = new ActorCache(pool);
    const first = cache.get("u1");
    loads[0]!.resolve(actor("a"));
    await first;
    expect(await cache.get("u1")).toEqual(actor("a"));
    expect(loads).toHaveLength(1);
  });
});
