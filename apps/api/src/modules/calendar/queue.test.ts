import { QUEUE_NAMES, newId } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { calendarTick } from "./queue";

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ preset: "general" });
});
afterAll(async () => h.close());

/** A connection, written as its person (row-level security: their own row only). */
async function connection(status: string, nextSyncAt: Date): Promise<string> {
  const user = await h.seedUser({});
  const id = newId();
  const c = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true)", [user.id]);
    await c.query(
      "INSERT INTO calendar_connections (id, user_id, google_email, grant_enc, status, next_sync_at) VALUES ($1, $2, 'x@y.test', '\\x00', $3, $4)",
      [id, user.id, status, nextSyncAt],
    );
    await c.query("COMMIT");
  } finally {
    c.release();
  }
  return id;
}

describe("the calendar queue's tick (5A Task 5)", () => {
  it("is a queue LUME creates", () => {
    expect(QUEUE_NAMES).toContain("calendar.sync");
  });

  it("asks once for each active connection that's due; not again while that ask waits; again after five minutes", async () => {
    let now = new Date("2026-09-21T09:00:00Z");
    const due = await connection("active", new Date("2026-09-21T08:00:00Z"));
    await connection("active", new Date("2026-09-21T10:00:00Z"));
    await connection("needs_reconnect", new Date("2026-09-21T08:00:00Z"));
    const asked: string[] = [];
    const tick = calendarTick({
      pool: h.pool,
      enqueue: async (id) => void asked.push(id),
      held: () => false,
      now: () => now,
    });
    expect(await tick()).toBe(1);
    expect(asked).toEqual([due]);
    expect(await tick()).toBe(0);
    now = new Date(now.getTime() + 5 * 60_000 + 1);
    expect(await tick()).toBe(1);
    expect(asked).toEqual([due, due]);
  });

  it("asks for nothing while the licence holds scheduled work back", async () => {
    const asked: string[] = [];
    const tick = calendarTick({
      pool: h.pool,
      enqueue: async (id) => void asked.push(id),
      held: () => true,
      now: () => new Date("2026-09-22T00:00:00Z"),
    });
    expect(await tick()).toBe(0);
    expect(asked).toEqual([]);
  });
});
