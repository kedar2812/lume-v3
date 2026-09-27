import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { withJobRequest } from "./job-request";

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
});
afterAll(async () => h.close());

describe("withJobRequest", () => {
  it("runs as the actor, sees every lead when asked, and commits", async () => {
    const rep = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] });
    const other = await h.seedUser({ grants: ALL_GRANTS });
    const leadId = await h.seedLead({ name: "Someone else's", ownerId: other.id });
    const actor = (await h.actorOf(rep.id))!;
    const seen = await withJobRequest(
      { app: h.app, pool: h.pool, actor, requestId: "t1", allLeads: true },
      async (req) => (await req.db.execute(`SELECT id FROM leads WHERE id = '${leadId}'`)).rows.length,
    );
    expect(seen).toBe(1);
    const narrow = await withJobRequest(
      { app: h.app, pool: h.pool, actor, requestId: "t2", allLeads: false },
      async (req) => (await req.db.execute(`SELECT id FROM leads WHERE id = '${leadId}'`)).rows.length,
    );
    expect(narrow).toBe(0);
  });

  it("rolls back when the work throws", async () => {
    const admin = await h.seedUser({ grants: ALL_GRANTS });
    const actor = (await h.actorOf(admin.id))!;
    await expect(
      withJobRequest({ app: h.app, pool: h.pool, actor, requestId: "t3", allLeads: true }, async (req) => {
        await req.db.execute(
          `INSERT INTO lead_sources (id, type, name) VALUES ('00000000-0000-7000-8000-00000000abcd', 'csv', 'x')`,
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(
      (await h.pool.query(`SELECT 1 FROM lead_sources WHERE id = '00000000-0000-7000-8000-00000000abcd'`))
        .rowCount,
    ).toBe(0);
  });
});
