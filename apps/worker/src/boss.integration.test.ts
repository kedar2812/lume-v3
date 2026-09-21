import { afterAll, describe, expect, it, vi } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import { MIGRATIONS_DIR_DEFAULT, createTestDatabase, installQueueSchema, migrate } from "@lume/db";
import { startQueue } from "./boss";

describe("worker queue as lume_worker", () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterAll(async () => {
    for (const f of cleanup.reverse()) await f();
  });

  it("starts without schema rights, schedules the ops crons and processes a job", async () => {
    const db = await createTestDatabase();
    cleanup.push(() => db.drop());
    await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
    await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);

    const backup = vi.fn(async () => ({ name: "x", bytes: 1, deleted: [] }));
    const log = { info: vi.fn(), error: vi.fn() };
    const boss = await startQueue({
      connectionString: db.url("lume_worker"),
      jobs: { backup, restoreTest: vi.fn() },
      log,
    });
    cleanup.push(() => boss.stop({ graceful: false, wait: true }));

    const schedules = await boss.getSchedules();
    expect(schedules.map((s) => [s.name, s.cron]).sort()).toEqual([
      ["ops.backup", "0 */6 * * *"],
      ["ops.restore-test", "0 4 * * 1"],
    ]);
    await boss.send("ops.backup", {});
    await vi.waitFor(() => expect(backup).toHaveBeenCalledTimes(1), { timeout: 15_000, interval: 250 });
    // Cron delivery goes through pg-boss's internal queue. pg-boss swallows the error when it can't
    // create it, so check it exists; otherwise scheduled backups would silently never fire.
    expect(await boss.getQueue("__pgboss__send-it")).toBeTruthy();
    expect(log.error).not.toHaveBeenCalled();
  });
});
