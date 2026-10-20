import { topUpBody } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addTopUp, getClient, listAlerts } from "./clients";
import type { Ctx } from "./context";
import { handleTopUp } from "./topup";
import { bindInstall, licenceDb, seedClient, testCtx, type LicenceTestDb } from "./testing";

/** Autopilot A1 Task 2 (spec 2026-10-19 §4): a client's admin asks the owner for a LUME AI top-up. */
let db: LicenceTestDb;
let now = new Date("2026-10-20T10:00:00Z");
let ctx: Ctx;
beforeAll(async () => {
  db = await licenceDb();
});
afterAll(() => db.close());
beforeEach(() => {
  now = new Date("2026-10-20T10:00:00Z");
  ctx = testCtx(db.pool, () => now);
});

async function bound(name: string) {
  const s = await seedClient(db.pool, { type: "subscription", paidUntil: "2026-12-31", name });
  return { ...s, installId: await bindInstall(db.pool, s.clientId) };
}
const ask = (s: { instanceId: string; licenseKey: string; installId: string }, over: Record<string, unknown> = {}) =>
  handleTopUp(
    new Request("https://licence.test/v1/topup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "198.51.100.30" },
      body: JSON.stringify({
        ...topUpBody({
          instanceId: s.instanceId,
          licenseKey: s.licenseKey,
          installId: s.installId,
          appVersion: "1.6.0",
          month: "2026-10",
          askedBy: { name: "Priya Shah", email: "priya@harbour.example" },
          note: "We're running Autopilot on a big campaign.",
        }),
        ...over,
      }),
    }),
    ctx,
  );

describe("POST /v1/topup", () => {
  it("keeps the request from the install its key is bound to, with a line in the history", async () => {
    const s = await bound("Harbour Clinic");
    const r = await ask(s);
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ asked: true });
    const row = (await db.pool.query("SELECT * FROM topup_requests WHERE client_id = $1", [s.clientId])).rows[0];
    expect(row).toMatchObject({ month: "2026-10", asked_by_name: "Priya Shah", done_at: null });
    const ev = await db.pool.query("SELECT kind FROM events WHERE client_id = $1", [s.clientId]);
    expect(ev.rows.map((e) => e.kind)).toContain("topup_requested");
  });

  it("one request a month: asking again says it's already asked", async () => {
    const s = await bound("Lakeview Dental");
    expect((await ask(s)).status).toBe(201);
    const again = await ask(s);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ asked: true, already: true });
    const n = await db.pool.query("SELECT count(*)::int AS n FROM topup_requests WHERE client_id = $1", [s.clientId]);
    expect(n.rows[0].n).toBe(1);
  });

  it("a key that isn't this install's is 401, and nothing is kept", async () => {
    const s = await bound("Northgate Realty");
    const r = await ask({ ...s, licenseKey: "LUME-WRNG-WRNG-WRNG-WRNG" });
    expect(r.status).toBe(401);
    const n = await db.pool.query("SELECT count(*)::int AS n FROM topup_requests WHERE client_id = $1", [s.clientId]);
    expect(n.rows[0].n).toBe(0);
  });

  it("a month that isn't one is refused", async () => {
    const s = await bound("Sunrise Studio");
    expect((await ask(s, { month: "October" })).status).toBe(400);
  });
});

describe("the owner sees it, and adds a top-up", () => {
  it("the request shows as an alert until a top-up for that month is added; adding one closes it", async () => {
    const s = await bound("Cedar Fitness");
    await ask(s);
    const alerts = (await listAlerts(ctx)).alerts.filter((a) => a.clientId === s.clientId);
    expect(alerts.map((a) => a.title)).toContain("Cedar Fitness asked for a LUME AI top-up");
    const before = await getClient(ctx, s.clientId);
    expect(before.topUps.requests).toEqual([
      expect.objectContaining({ month: "2026-10", askedBy: "Priya Shah", note: "We're running Autopilot on a big campaign." }),
    ]);

    const after = await addTopUp(ctx, s.clientId, { month: "2026-10", calls: 1500, note: "Campaign week" });
    expect(after.topUps.requests).toEqual([]);
    expect(after.topUps.added).toEqual([expect.objectContaining({ month: "2026-10", calls: 1500 })]);
    expect((await listAlerts(ctx)).alerts.filter((a) => a.clientId === s.clientId).map((a) => a.title)).not.toContain(
      "Cedar Fitness asked for a LUME AI top-up",
    );
  });

  it("a top-up is a whole number between 1 and 10,000,000, in words", async () => {
    const s = await bound("Pine Bakery");
    await expect(addTopUp(ctx, s.clientId, { month: "2026-10", calls: 0 })).rejects.toThrow("At least 1");
    await expect(addTopUp(ctx, s.clientId, { month: "2026-13", calls: 5 })).rejects.toThrow("month");
  });
});
