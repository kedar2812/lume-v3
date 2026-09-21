import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

describe("GET /audit", () => {
  it("pages newest-first with a cursor and filters by action", async () => {
    for (let i = 0; i < 5; i++)
      await h.pool.query("INSERT INTO audit_log (action, entity_type) VALUES ('t.page', 't')");
    const c = await h.signIn(await h.seedUser({ grants: [{ key: "audit.view", scope: null }] }));
    const p1 = (await c.inject({ method: "GET", url: "/api/v1/audit?action=t.page&limit=3" })).json();
    expect(p1.entries).toHaveLength(3);
    const p2 = (
      await c.inject({ method: "GET", url: `/api/v1/audit?action=t.page&limit=3&cursor=${p1.nextCursor}` })
    ).json();
    expect(p2.entries).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();
    expect(p1.entries[0].id).toBeGreaterThan(p2.entries[0].id);
  });

  it("never returns more than 100 per page", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [{ key: "audit.view", scope: null }] }));
    expect((await c.inject({ method: "GET", url: "/api/v1/audit?limit=500" })).statusCode).toBe(400);
  });
});
