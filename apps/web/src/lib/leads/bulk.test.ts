import { describe, expect, it, vi } from "vitest";
import { leadsClient } from "./client";
import { bulkSummary, runBulkInChunks } from "./bulk";

vi.mock("./client", () => ({ leadsClient: { bulk: vi.fn() } }));

describe("bulkSummary", () => {
  it("says what happened and why anything was skipped, in plain words", () => {
    expect(
      bulkSummary(
        { type: "stage", stageId: "s" },
        { updated: ["a", "b", "c"], skipped: [{ id: "d", code: "LOST_REASON_REQUIRED" }] },
      ),
    ).toBe("3 moved, 1 skipped: needs a lost reason");
    expect(bulkSummary({ type: "assign", ownerId: "u" }, { updated: ["a"], skipped: [] })).toBe(
      "1 reassigned",
    );
    expect(
      bulkSummary(
        { type: "delete" },
        {
          updated: [],
          skipped: [
            { id: "a", code: "FORBIDDEN" },
            { id: "b", code: "REQUIRED_FIELDS" },
          ],
        },
      ),
    ).toBe("None deleted, 2 skipped: 1 not yours to change, 1 missing required fields");
    expect(
      bulkSummary(
        { type: "tags", add: ["t"] },
        { updated: ["a", "b"], skipped: [{ id: "c", code: "SOMETHING_NEW" }] },
      ),
    ).toBe("2 updated, 1 skipped: couldn’t be changed");
  });
});

describe("runBulkInChunks", () => {
  it("never sends more than 100 ids in one request, and merges the answers", async () => {
    vi.mocked(leadsClient.bulk).mockImplementation(async (ids) => ({
      ok: true,
      status: 200,
      data: { updated: ids, skipped: [] },
    }));
    const ids = Array.from({ length: 230 }, (_, i) => `id${i}`);
    const r = await runBulkInChunks(ids, { type: "delete" });
    expect(vi.mocked(leadsClient.bulk).mock.calls.map(([chunk]) => chunk.length)).toEqual([100, 100, 30]);
    expect(r.updated).toHaveLength(230);
  });
});
