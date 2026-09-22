import { describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "./queues";

describe("QUEUE_NAMES", () => {
  it("lists every ops queue exactly once", () => {
    expect(QUEUE_NAMES).toEqual(["ops.backup", "ops.restore-test", "ops.idempotency-cleanup"]);
    expect(new Set(QUEUE_NAMES).size).toBe(QUEUE_NAMES.length);
  });
});
