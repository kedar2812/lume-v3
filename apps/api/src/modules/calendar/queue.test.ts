import { QUEUE_NAMES, newId } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { calendarTick } from "./queue";

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  await h.ownerPool.query(
    `UPDATE settings SET integrations = '{"googleCalendar":{"enabled":true}}' WHERE id = 1`,
  );
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

  it("asks for nothing while Google Calendar is switched off", async () => {
    await connection("active", new Date("2026-09-21T08:00:00Z"));
    await h.ownerPool.query(`UPDATE settings SET integrations = '{}' WHERE id = 1`);
    try {
      const asked: string[] = [];
      const tick = calendarTick({
        pool: h.pool,
        enqueue: async (id) => void asked.push(id),
        held: () => false,
        now: () => new Date("2026-09-22T00:00:00Z"),
      });
      expect(await tick()).toBe(0);
    } finally {
      await h.ownerPool.query(
        `UPDATE settings SET integrations = '{"googleCalendar":{"enabled":true}}' WHERE id = 1`,
      );
    }
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

describe("a sync asked for while one runs (5D Task 2, Review Focus 3)", () => {
  it("is asked again shortly, up to a limit, rather than dropped", async () => {
    const { handleSyncJob } = await import("./queue");
    const sent: { id: string; tries: number; after: number }[] = [];
    const resend = async (data: { id: string; tries: number }, afterSeconds: number) => {
      sent.push({ ...data, after: afterSeconds });
    };
    await handleSyncJob(async () => "busy", { id: "c1" }, resend);
    expect(sent).toEqual([{ id: "c1", tries: 1, after: 3 }]);
    await handleSyncJob(async () => "busy", { id: "c1", tries: 40 }, resend);
    expect(sent).toHaveLength(1); // two minutes of waiting is enough: the next tick asks again
    await handleSyncJob(async () => "synced", { id: "c1", tries: 3 }, resend);
    expect(sent).toHaveLength(1);
  });
});
