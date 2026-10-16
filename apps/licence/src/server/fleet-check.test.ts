import { checkBody, rawPublicKey, verifyLicence, type FleetHealth } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleCheck } from "./check";
import type { Ctx } from "./context";
import { licenceDb, seedClient, TEST_PAIR, testCtx, type LicenceTestDb } from "./testing";

/** Fleet (spec 2026-10-16 fleet §1–§2.3): health with a check-in, and announcements only for installs that can show them. */
const KEYS = { t1: rawPublicKey(TEST_PAIR.publicKey) };
const INSTALL = "0190e0c0-0000-7000-8000-0000000000a1";
let t: LicenceTestDb;
let now = new Date("2026-10-16T09:00:00Z");
let ctx: Ctx;

const health: FleetHealth = {
  uptimeS: 86_400,
  dbBytes: 420_000_000,
  diskFreePct: 38,
  errors24h: 1,
  queue: { waiting: 2, retrying: 0, failed24h: 0 },
  remindersLate: 0,
  restoreTest: { at: "2026-10-14T03:15:00.000Z", ok: true },
  problems: [],
  sourcesNeedingAttention: 0,
};
const body = (
  c: { instanceId: string; licenseKey: string },
  more: Partial<Parameters<typeof checkBody>[0]> = {},
) =>
  checkBody({
    instanceId: c.instanceId,
    licenseKey: c.licenseKey,
    installId: INSTALL,
    appVersion: "1.5.0",
    activeUserCount: 4,
    leadCount: 312,
    now,
    ...more,
  });
const post = (data: unknown) =>
  handleCheck(
    new Request("http://licence.test/v1/check", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9" },
      body: JSON.stringify(data),
    }),
    ctx,
  );
const payloadOf = async (r: Response, instanceId: string) =>
  verifyLicence(((await r.json()) as { token: string }).token, KEYS, instanceId);

let n = 0;
async function announce(o: {
  title?: string;
  clients?: string[];
  startsAt?: Date;
  endsAt?: Date;
  withdrawn?: boolean;
  createdAt?: Date;
}): Promise<string> {
  const id = `0190e0c0-0000-7000-8000-${String(++n).padStart(12, "0")}`;
  await t.pool.query(
    `INSERT INTO announcements (id, title, body, kind, audience, all_clients, starts_at, ends_at, created_at, withdrawn_at)
     VALUES ($1, $2, 'Plain words.', 'update', 'everyone', $3, $4, $5, $6, $7)`,
    [
      id,
      o.title ?? `Announcement ${n}`,
      !o.clients,
      o.startsAt ?? new Date(now.getTime() - 3_600_000),
      o.endsAt ?? new Date(now.getTime() + 7 * 86_400_000),
      o.createdAt ?? new Date(now.getTime() - 3_600_000 + n * 1000),
      o.withdrawn ? now : null,
    ],
  );
  for (const c of o.clients ?? [])
    await t.pool.query("INSERT INTO announcement_clients (announcement_id, client_id) VALUES ($1, $2)", [
      id,
      c,
    ]);
  return id;
}

beforeAll(async () => {
  t = await licenceDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  now = new Date("2026-10-16T09:00:00Z");
  ctx = testCtx(t.pool, () => now);
  await t.pool.query("DELETE FROM announcements");
});

describe("/v1/check and the fleet", () => {
  it("answers an install that doesn't say what it can show with exactly today's payload, however many are live", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    await announce({});
    const p = await payloadOf(await post(body(c)), c.instanceId);
    expect(Object.keys(p!).sort()).toEqual(
      [
        "instanceId",
        "issuedAt",
        "kid",
        "licenseType",
        "notice",
        "paidUntil",
        "reason",
        "state",
        "trialEndsAt",
        "v",
        "validUntil",
      ].sort(),
    );
  });

  it("signs the live ones for this client, newest first, at most three", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    const other = await seedClient(t.pool, { type: "perpetual" });
    const all = await announce({ title: "For everyone" });
    const mine = await announce({ title: "For this client", clients: [c.clientId] });
    await announce({ title: "For another client", clients: [other.clientId] });
    await announce({ title: "Withdrawn", withdrawn: true });
    await announce({ title: "Ended", endsAt: new Date(now.getTime() - 1000) });
    await announce({ title: "Not yet", startsAt: new Date(now.getTime() + 3_600_000) });
    const p = await payloadOf(await post(body(c, { accepts: ["announcements"] })), c.instanceId);
    expect(p!.announcements!.map((a) => a.id)).toEqual([mine, all]);
    expect(p!.announcements![0]).toMatchObject({
      title: "For this client",
      kind: "update",
      audience: "everyone",
    });

    for (let i = 0; i < 3; i++) await announce({});
    const q = await payloadOf(await post(body(c, { accepts: ["announcements"] })), c.instanceId);
    expect(q!.announcements).toHaveLength(3);
  });

  it("keeps the health and what the install can show with its check-in", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    expect((await post(body(c, { accepts: ["announcements"], health }))).status).toBe(200);
    const { rows } = await t.pool.query<{ health: FleetHealth; accepts: string[] }>(
      "SELECT health, accepts FROM check_ins WHERE client_id = $1 ORDER BY at DESC LIMIT 1",
      [c.clientId],
    );
    expect(rows[0]).toEqual({ health, accepts: ["announcements"] });
  });

  it("refuses health with a problem it doesn't know, or a name in it", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    const bad = { ...body(c, { health }), health: { ...health, problems: ["Instagram leads sheet"] } };
    expect((await post(bad)).status).toBe(400);
    expect((await post({ ...body(c, { health }), health: { ...health, source: "Instagram" } })).status).toBe(
      400,
    );
  });

  it("records how many people pressed Got it, for this client's own announcements only", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    const other = await seedClient(t.pool, { type: "perpetual" });
    const all = await announce({});
    const theirs = await announce({ clients: [other.clientId] });
    const seen = [
      { id: all, people: 9 },
      { id: theirs, people: 4 },
      { id: "0190e0c0-0000-7000-8000-ffffffffffff", people: 2 },
    ];
    expect((await post(body(c, { accepts: ["announcements"], seen }))).status).toBe(200);
    const { rows } = await t.pool.query<{ announcement_id: string; people: number }>(
      "SELECT announcement_id, people FROM announcement_seen WHERE client_id = $1",
      [c.clientId],
    );
    expect(rows).toEqual([{ announcement_id: all, people: 9 }]);
    now = new Date(now.getTime() + 3_600_000);
    await post(body(c, { accepts: ["announcements"], seen: [{ id: all, people: 11 }] }));
    const after = await t.pool.query("SELECT people FROM announcement_seen WHERE client_id = $1", [
      c.clientId,
    ]);
    expect(after.rows).toEqual([{ people: 11 }]);
  });
});
