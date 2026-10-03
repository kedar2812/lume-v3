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

  it("filters to one day on the business's clock, so a figure can open its own entries (6C)", async () => {
    const tz =
      (await h.ownerPool.query("SELECT timezone FROM settings WHERE id = 1")).rows[0]?.timezone ?? "UTC";
    // 23:30 yesterday and 00:30 today, both on the business's clock.
    await h.pool.query(
      `INSERT INTO audit_log (action, entity_type, at) VALUES
         ('t.day', 'late', (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1) - interval '30 minutes'),
         ('t.day', 'early', (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1) + interval '30 minutes')`,
      [tz],
    );
    const today = (await h.pool.query("SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS d", [tz]))
      .rows[0].d;
    const c = await h.signIn(await h.seedUser({ grants: [{ key: "audit.view", scope: null }] }));
    const r = (await c.inject({ method: "GET", url: `/api/v1/audit?action=t.day&day=${today}` })).json();
    expect(r.entries.map((e: { entityType: string }) => e.entityType)).toEqual(["early"]);
    expect((await c.inject({ method: "GET", url: "/api/v1/audit?day=yesterday" })).statusCode).toBe(400);
  });

  it("never returns more than 100 per page", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [{ key: "audit.view", scope: null }] }));
    expect((await c.inject({ method: "GET", url: "/api/v1/audit?limit=500" })).statusCode).toBe(400);
  });

  it("names who did it, so an auditor needs no other access to read the log", async () => {
    const actor = await h.seedUser({ grants: [], name: "Dana Actor" });
    await h.pool.query(
      "INSERT INTO audit_log (action, entity_type, actor_user_id) VALUES ('t.named', 't', $1)",
      [actor.id],
    );
    const c = await h.signIn(await h.seedUser({ grants: [{ key: "audit.view", scope: null }] }));
    const { entries } = (await c.inject({ method: "GET", url: "/api/v1/audit?action=t.named" })).json();
    expect(entries[0]).toMatchObject({ actorUserId: actor.id, actorName: "Dana Actor" });
  });
});
