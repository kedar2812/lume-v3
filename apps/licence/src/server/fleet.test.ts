import type { FleetHealth } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getClient, listAlerts, Refusal } from "./clients";
import type { Ctx } from "./context";
import { createAnnouncement, fleet, getAnnouncement, listAnnouncements, withdrawAnnouncement } from "./fleet";
import { licenceDb, seedClient, testCtx, type LicenceTestDb } from "./testing";

/** Fleet on the dashboard (spec 2026-10-16 fleet §2.2–§2.4). */
let t: LicenceTestDb;
let now = new Date("2026-10-16T12:00:00Z");
let ctx: Ctx;
const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
const well: FleetHealth = {
  uptimeS: 86_400,
  dbBytes: 400_000_000,
  diskFreePct: 40,
  errors24h: 0,
  queue: { waiting: 1, retrying: 0, failed24h: 0 },
  remindersLate: 0,
  restoreTest: { at: ago(30).toISOString(), ok: true },
  problems: [],
  sourcesNeedingAttention: 0,
};
async function checkIn(
  clientId: string,
  at: Date,
  o: { health?: FleetHealth | null; accepts?: boolean; version?: string } = {},
) {
  await t.pool.query(
    `INSERT INTO check_ins (client_id, at, ip, app_version, active_users, lead_count, server_time, state, health, accepts)
     VALUES ($1, $2, '198.51.100.7', $3, 4, 300, $2, 'active', $4, $5)`,
    [
      clientId,
      at,
      o.version ?? "1.5.0",
      o.health === undefined ? JSON.stringify(well) : o.health === null ? null : JSON.stringify(o.health),
      o.accepts === false ? null : ["announcements"],
    ],
  );
}
const valid = {
  title: "LUME will be updated on Saturday night",
  body: "LUME will be away for about 30 minutes while it's updated.",
  kind: "maintenance" as const,
  windowStart: "2026-10-18T16:30:00.000Z",
  windowEnd: "2026-10-18T17:00:00.000Z",
  audience: "admins" as const,
  clients: "all" as const,
  startsAt: null,
  endsAt: "2026-10-19T00:00:00.000Z",
};

beforeAll(async () => {
  t = await licenceDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  now = new Date("2026-10-16T12:00:00Z");
  ctx = testCtx(t.pool, () => now);
  await t.pool.query("DELETE FROM announcements; DELETE FROM clients");
});

describe("GET /api/fleet", () => {
  it("lists every live client worst first, with its problems in words and the counts per status", async () => {
    const ok = await seedClient(t.pool, { type: "perpetual" });
    const look = await seedClient(t.pool, { type: "perpetual" });
    const down = await seedClient(t.pool, { type: "perpetual" });
    const old = await seedClient(t.pool, { type: "perpetual" });
    await seedClient(t.pool, { type: "perpetual", decommissioned: true });
    await checkIn(ok.clientId, ago(2));
    await checkIn(look.clientId, ago(3), {
      health: { ...well, diskFreePct: 4, problems: ["jobs_failed"], queue: { ...well.queue, failed24h: 2 } },
    });
    await checkIn(down.clientId, ago(30));
    await checkIn(old.clientId, ago(5), { health: null, accepts: false, version: "1.4.2" });
    const f = await fleet(ctx);
    expect(f.rows.map((r) => [r.id, r.status])).toEqual([
      [down.clientId, "down"],
      [look.clientId, "look"],
      [old.clientId, "none"],
      [ok.clientId, "ok"],
    ]);
    expect(f.rows[1]!.problems.map((p) => p.short)).toEqual(["Disk almost full", "Jobs failing"]);
    expect(f.rows[1]).toMatchObject({
      diskFreePct: 4,
      dbBytes: 400_000_000,
      people: 4,
      leads: 300,
      acceptsAnnouncements: true,
    });
    expect(f.rows[2]).toMatchObject({ acceptsAnnouncements: false, dbBytes: null, version: "1.4.2" });
    expect(f.counts).toMatchObject({ total: 4, online: 3, look: 1, down: 1, none: 1 });
  });
});

describe("a client's health", () => {
  it("is on the client: the latest, and one point a day for 14 days", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    for (let d = 3; d >= 0; d--)
      await checkIn(c.clientId, ago(d * 24 + 1), {
        health: { ...well, dbBytes: 100 + d, diskFreePct: 50 - d },
      });
    await checkIn(c.clientId, ago(0.5), { health: { ...well, dbBytes: 99, diskFreePct: 51 } });
    const r = await getClient(ctx, c.clientId);
    expect(r.health).toMatchObject({ status: "ok", problems: [], health: { dbBytes: 99 } });
    expect(r.healthTrend.map((p) => p.dbBytes)).toEqual([103, 102, 101, 99]);
  });
  it("says nothing for a client on an older LUME", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    await checkIn(c.clientId, ago(1), { health: null });
    expect((await getClient(ctx, c.clientId)).health).toMatchObject({ status: "none", health: null });
  });
});

describe("announcements", () => {
  it("publishes one, writes it to each client's history, and counts how far it got", async () => {
    const a = await seedClient(t.pool, { type: "perpetual" });
    const b = await seedClient(t.pool, { type: "perpetual" });
    const c = await seedClient(t.pool, { type: "perpetual" });
    const { announcement } = await createAnnouncement(ctx, valid);
    expect(announcement).toMatchObject({
      title: valid.title,
      state: "live",
      audienceText: "Admins at all clients",
    });
    const events = await t.pool.query(
      "SELECT client_id FROM events WHERE kind = 'announcement' AND detail->>'action' = 'published'",
    );
    expect(events.rowCount).toBe(3);

    now = new Date(now.getTime() + 60_000);
    await checkIn(a.clientId, now);
    await checkIn(b.clientId, now, { health: null, accepts: false });
    await t.pool.query(
      "INSERT INTO announcement_seen (announcement_id, client_id, people, at) VALUES ($1, $2, 5, $3)",
      [announcement.id, a.clientId, now],
    );
    const listed = (await listAnnouncements(ctx)).announcements[0]!;
    expect(listed.reach).toEqual({ audience: 3, reached: 1, cannot: 1, waiting: 1, seenBy: 5 });
    const one = await getAnnouncement(ctx, announcement.id);
    expect(one.clients.map((x) => [x.id, x.reach]).sort()).toEqual(
      [
        [a.clientId, "reached"],
        [b.clientId, "older"],
        [c.clientId, "waiting"],
      ].sort(),
    );
  });

  it("goes to chosen clients only, and a withdrawn one says so and leaves the next answers", async () => {
    const a = await seedClient(t.pool, { type: "perpetual" });
    await seedClient(t.pool, { type: "perpetual" });
    const { announcement } = await createAnnouncement(ctx, {
      ...valid,
      kind: "update",
      windowStart: null,
      windowEnd: null,
      audience: "everyone",
      clients: [a.clientId],
    });
    expect(announcement.audienceText).toBe("Everyone at 1 client");
    expect((await listAnnouncements(ctx)).announcements[0]!.reach.audience).toBe(1);
    const w = await withdrawAnnouncement(ctx, announcement.id);
    expect(w.announcement.state).toBe("withdrawn");
    const events = await t.pool.query(
      "SELECT detail FROM events WHERE kind = 'announcement' AND client_id = $1 ORDER BY at, id",
      [a.clientId],
    );
    expect(events.rows.map((r) => r.detail.action)).toEqual(["published", "withdrawn"]);
  });

  it("is scheduled when it starts later, and ended once over", async () => {
    await seedClient(t.pool, { type: "perpetual" });
    await createAnnouncement(ctx, {
      ...valid,
      startsAt: "2026-10-17T09:00:00.000Z",
      endsAt: "2026-10-20T09:00:00.000Z",
    });
    expect((await listAnnouncements(ctx)).announcements[0]!.state).toBe("scheduled");
    now = new Date("2026-10-21T00:00:00Z");
    expect((await listAnnouncements(ctx)).announcements[0]!.state).toBe("ended");
  });

  it("refuses what can't be shown: lengths, a maintenance without its window, an update with one, more than 60 days, an end already past, no clients", async () => {
    await seedClient(t.pool, { type: "perpetual" });
    const refused = async (o: object) =>
      expect(createAnnouncement(ctx, { ...valid, ...o } as never)).rejects.toBeInstanceOf(Refusal);
    await refused({ title: "" });
    await refused({ title: "x".repeat(81) });
    await refused({ body: "x".repeat(601) });
    await refused({ windowStart: null, windowEnd: null });
    await refused({ kind: "update" });
    await refused({ windowEnd: "2026-10-18T16:00:00.000Z" });
    await refused({ endsAt: "2026-12-20T00:00:00.000Z" });
    await refused({ endsAt: "2026-10-16T11:00:00.000Z" });
    await refused({ clients: [] });
  });
});

describe("the bell", () => {
  it("says a client needs a look, and a disk almost full in red, each shown again when the problem changes", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    await checkIn(c.clientId, ago(1), { health: { ...well, diskFreePct: 3, problems: ["reminders_late"] } });
    const { alerts } = await listAlerts(ctx);
    const disk = alerts.find((a) => a.id === `disk:${c.clientId}`)!;
    const look = alerts.find((a) => a.id === `look:${c.clientId}`)!;
    expect(disk).toMatchObject({ tone: "red" });
    expect(disk.body).toMatch(/3% free/);
    expect(look).toMatchObject({ tone: "amber", fingerprint: "reminders_late" });
    expect(look.body).toMatch(/Follow-up reminders are late/);
  });
});
