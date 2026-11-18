import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { settleRemindersMany } from "./lifecycle";

/** A request that records what it would run: no database, so only the shape of the work is under test. */
function fakeRequest(actorId: string) {
  const later: (() => void)[] = [];
  const settle = vi.fn<(userId: string, ids: string | string[]) => Promise<void>>(async () => {});
  const execute = vi.fn(async () => ({ rows: [] as unknown[] }));
  const req = {
    actor: { userId: actorId },
    db: { execute },
    afterCommit: (fn: () => void) => later.push(fn),
    server: { settleReminders: settle },
    log: { error: vi.fn() },
  } as unknown as FastifyRequest;
  return { req, later, settle, execute };
}

describe("settleRemindersMany: many follow-ups closed at once (review 2026-11-18)", () => {
  it("someone else's reminders are read once per person after commit, not once per follow-up", async () => {
    const { req, later, settle } = fakeRequest("admin");
    await settleRemindersMany(req, [
      { id: "t1", assigneeId: "sam" },
      { id: "t2", assigneeId: "sam" },
      { id: "t3", assigneeId: "sam" },
      { id: "t4", assigneeId: "riya" },
    ]);
    expect(settle).not.toHaveBeenCalled(); // nothing before the commit
    later.forEach((fn) => fn());
    expect(settle).toHaveBeenCalledTimes(2);
    expect(settle).toHaveBeenCalledWith("sam", ["t1", "t2", "t3"]);
    expect(settle).toHaveBeenCalledWith("riya", ["t4"]);
  });

  it("your own are read in this transaction, in one statement; nothing is left for after", async () => {
    const { req, later, settle, execute } = fakeRequest("sam");
    await settleRemindersMany(req, [
      { id: "t1", assigneeId: "sam" },
      { id: "t2", assigneeId: "sam" },
    ]);
    expect(later).toHaveLength(0);
    expect(settle).not.toHaveBeenCalled();
    // One for everyone's notices (0114), one UPDATE of your own, one signal to your bell.
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("none closed: nothing runs", async () => {
    const { req, later, execute } = fakeRequest("sam");
    await settleRemindersMany(req, []);
    expect(execute).not.toHaveBeenCalled();
    expect(later).toHaveLength(0);
  });
});
