import { ALL_GRANTS, DEFAULT_RULES, type Mapping } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { loadMapContext } from "./context";
import { jobServer, withJobRequest } from "./job-request";
import { writeRow } from "./row";

let h: Harness;
let userId: string;
beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  userId = (await h.seedUser({ grants: ALL_GRANTS, totp: true })).id;
});
afterAll(async () => h.close());

const mapping: Mapping = {
  columns: [
    { column: 0, to: "field", field: "name" },
    { column: 1, to: "field", field: "phone" },
  ],
  createMissingTags: false,
};

describe("writeRow", () => {
  it("creates, then merges the same contact, recording where each came from", async () => {
    const actor = (await h.actorOf(userId))!;
    const pipelineId = (await h.queryAll<{ id: string }>("SELECT id FROM pipelines WHERE is_default"))[0]!.id;
    const stageId = (
      await h.queryAll<{ id: string }>(
        "SELECT id FROM stages WHERE pipeline_id = $1 AND kind = 'open' ORDER BY position LIMIT 1",
        [pipelineId],
      )
    )[0]!.id;
    const sourceId = (
      await h.queryAll<{ id: string }>(
        "INSERT INTO lead_sources (id, type, name, status) VALUES (gen_random_uuid(), 'google_sheet', 'Enquiries', 'active') RETURNING id",
      )
    )[0]!.id;
    const rules = DEFAULT_RULES({ pipelineId, stageId, country: "AE" });
    let turn = 0;
    const run = (cells: string[], row: number) =>
      withJobRequest(
        { app: jobServer(h.app), pool: h.pool, actor, requestId: `t:${row}`, allLeads: true },
        async (req) => {
          const ctx = await loadMapContext(req, { pipelineId, headerCount: 2 });
          return writeRow(req, {
            sourceId,
            rules,
            mapping,
            ctx,
            cells,
            origin: { sourceId, sheet: "Enquiries", row },
            nextTurn: async () => turn++,
          });
        },
      );
    const a = await run(["Row Writer", "0507778888"], 2);
    expect(a).toMatchObject({ result: "created", counters: { created: 1 } });
    expect(a.draft?.phone.e164).toBe("+971507778888");
    const b = await run(["Row Writer again", "+971 50 777 8888"], 9);
    expect(b).toMatchObject({ result: "merged", leadId: a.leadId, counters: { merged: 1 } });
    const acts = await h.queryAll<{ type: string; payload: Record<string, unknown> }>(
      "SELECT type, payload FROM activities WHERE lead_id = $1 ORDER BY occurred_at",
      [a.leadId],
    );
    expect(acts.find((x) => x.type === "imported")?.payload).toMatchObject({ sheet: "Enquiries", row: 2 });
    expect(acts.find((x) => x.type === "imported_again")?.payload).toMatchObject({
      sheet: "Enquiries",
      row: 9,
    });
    const c = await run(["", ""], 10);
    expect(c).toMatchObject({ result: "skipped", counters: { empty: 1 }, draft: null });
  });
});
