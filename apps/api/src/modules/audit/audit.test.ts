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

describe("GET /audit/csv (owner 2026-11-14)", () => {
  const DOWNLOAD = [
    { key: "audit.view" as const, scope: null },
    { key: "audit.export" as const, scope: null },
  ];
  const lines = (body: string) =>
    body
      .replace(/^\uFEFF/, "")
      .trim()
      .split("\r\n");
  const tzOf = async () =>
    (await h.ownerPool.query("SELECT timezone FROM settings WHERE id = 1")).rows[0]?.timezone ?? "UTC";

  it("the log in words, newest first, on the business's clock; formula-safe; the download itself audited", async () => {
    const actor = await h.seedUser({ grants: [], name: "=Riya Sharma" });
    await h.pool.query(
      `INSERT INTO audit_log (action, entity_type, entity_id, actor_user_id, at, diff) VALUES
         ('lead.create', 'lead', 'l-1', $1, '2026-03-01T10:00:00Z', '{}'),
         ('t.csv.unknown', 'thing', NULL, NULL, '2026-03-02T10:00:00Z', '{}'),
         ('lead.bulk', 'lead', NULL, $1, '2026-03-03T10:00:00Z', '{"type":"assign","updated":3}')`,
      [actor.id],
    );
    const tz = await tzOf();
    const local = async (iso: string) =>
      (
        await h.pool.query("SELECT to_char($1::timestamptz AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI') AS t", [
          iso,
          tz,
        ])
      ).rows[0].t as string;
    const c = await h.signIn(await h.seedUser({ grants: DOWNLOAD }));
    const res = await c.inject({ method: "GET", url: `/api/v1/audit/csv?actorUserId=${actor.id}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/csv/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.rawPayload.subarray(0, 3).toString("hex")).toBe("efbbbf");
    expect(res.headers["content-disposition"]).toMatch(
      /^attachment; filename="lume-audit-log-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const l = lines(res.body);
    expect(l[0]).toBe(`When (${tz}),Who,What happened,Item,Item ID`);
    expect(l.slice(1)).toEqual([
      `${await local("2026-03-03T10:00:00Z")},'=Riya Sharma,assigned 3 leads at once,lead,`,
      `${await local("2026-03-01T10:00:00Z")},'=Riya Sharma,added a lead,lead,l-1`,
    ]);

    // LUME itself, and an action with no words yet: said as its key, never dropped.
    const sys = lines(
      (await c.inject({ method: "GET", url: "/api/v1/audit/csv?action=t.csv.unknown" })).body,
    );
    expect(sys.slice(1)).toEqual([`${await local("2026-03-02T10:00:00Z")},LUME,t.csv.unknown,thing,`]);

    const audited = await h.queryAll<{ diff: Record<string, unknown> }>(
      "SELECT diff FROM audit_log WHERE action = 'audit.export' ORDER BY id DESC LIMIT 2",
    );
    expect(audited[1]!.diff).toMatchObject({ rows: 2, actorUserId: actor.id });
    expect(audited[0]!.diff).toMatchObject({ rows: 1, action: "t.csv.unknown" });
  });

  it("every entry, past one batch; nothing matching is the header alone", async () => {
    await h.pool.query(
      "INSERT INTO audit_log (action, entity_type) SELECT 't.csv.many', 't' FROM generate_series(1, 2105)",
    );
    const c = await h.signIn(await h.seedUser({ grants: DOWNLOAD }));
    const many = lines((await c.inject({ method: "GET", url: "/api/v1/audit/csv?action=t.csv.many" })).body);
    expect(many).toHaveLength(2106);
    const none = await c.inject({ method: "GET", url: "/api/v1/audit/csv?action=t.csv.none" });
    expect(none.statusCode).toBe(200);
    expect(lines(none.body)).toHaveLength(1);
  });

  it("only for people who may read the log and download it, refused in words", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [] }));
    expect((await c.inject({ method: "GET", url: "/api/v1/audit/csv" })).statusCode).toBe(403);
    const reader = await h.signIn(await h.seedUser({ grants: [{ key: "audit.view", scope: null }] }));
    const no = await reader.inject({ method: "GET", url: "/api/v1/audit/csv" });
    expect(no.statusCode).toBe(403);
    expect(no.json().error.code).toBe("NO_AUDIT_EXPORT");
    const only = await h.signIn(await h.seedUser({ grants: [{ key: "audit.export", scope: null }] }));
    expect((await only.inject({ method: "GET", url: "/api/v1/audit/csv" })).statusCode).toBe(403);
    const ok = await h.signIn(await h.seedUser({ grants: DOWNLOAD }));
    expect((await ok.inject({ method: "GET", url: "/api/v1/audit/csv?day=yesterday" })).statusCode).toBe(400);
  });
});
