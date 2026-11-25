import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { createNotices, noticeTuning, type NoticeKey } from "./notices";

/** The notice queue's test hook: a test that wipes the tables first lets go of what was waiting (CI deadlock 2026-11-25). */
const real = { ...noticeTuning };
afterEach(() => void Object.assign(noticeTuning, real));

const key: NoticeKey = { userId: "u1", conv: "c1", kind: "chat_direct", root: 0 };
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A pool whose connection is handed out only when the test says so (and then fails, as a wiped table would). */
function slowPool() {
  let give: () => void = () => {};
  const connect = vi.fn(
    () =>
      new Promise((resolve) => {
        give = () => resolve({ query: () => Promise.reject(new Error("gone")), release: () => {} });
      }),
  );
  return { pool: { connect } as unknown as pg.Pool, connect, give: () => give() };
}

describe("forget", () => {
  it("drops what was still waiting for its moment, so nothing is written after", async () => {
    noticeTuning.direct = 20;
    const p = slowPool();
    const q = createNotices(p.pool, () => {});
    q.soon(key);
    await q.forget();
    await later(60);
    expect(p.connect).not.toHaveBeenCalled();
    await q.stop();
  });

  it("waits for a notice already being written to finish", async () => {
    noticeTuning.direct = 0;
    const p = slowPool();
    const errors: unknown[] = [];
    const q = createNotices(p.pool, (e) => errors.push(e));
    q.soon(key);
    await vi.waitFor(() => expect(p.connect).toHaveBeenCalledTimes(1));
    let done = false;
    const f = q.forget().then(() => (done = true));
    await later(30);
    expect(done).toBe(false);
    p.give();
    await f;
    expect(done).toBe(true);
    expect(errors).toHaveLength(1);
    await q.stop();
  });

  it("drops one queued behind another that is being written", async () => {
    Object.assign(noticeTuning, { direct: 0, atOnce: 1 });
    const p = slowPool();
    const q = createNotices(p.pool, () => {});
    q.soon(key);
    q.soon({ ...key, userId: "u2" });
    await vi.waitFor(() => expect(p.connect).toHaveBeenCalledTimes(1));
    await later(20);
    const f = q.forget();
    p.give();
    await f;
    await later(30);
    expect(p.connect).toHaveBeenCalledTimes(1);
    await q.stop();
  });

  it("leaves the queue working for the next notice", async () => {
    noticeTuning.direct = 0;
    const p = slowPool();
    const q = createNotices(p.pool, () => {});
    q.soon(key);
    await q.forget();
    q.soon(key);
    await vi.waitFor(() => expect(p.connect).toHaveBeenCalled());
    p.give();
    await q.stop();
  });
});
