import { describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "./queues";

describe("QUEUE_NAMES", () => {
  it("lists the Phase 0 ops queues exactly once each", () => {
    expect(QUEUE_NAMES).toEqual(["ops.backup", "ops.restore-test"]);
    expect(new Set(QUEUE_NAMES).size).toBe(QUEUE_NAMES.length);
  });
});
