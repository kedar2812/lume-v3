import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "./context";
import { currentRates, refreshRates } from "./fx";
import { licenceDb, testCtx, type LicenceTestDb } from "./testing";

let t: LicenceTestDb;
let now: Date;
let ctx: Ctx;
let calls: string[];
let answer: () => Promise<Response>;

const ok = (rates: Record<string, number>) => () =>
  Promise.resolve(new Response(JSON.stringify({ result: "success", base_code: "INR", rates })));

beforeAll(async () => {
  t = await licenceDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.pool.query("DELETE FROM fx_rates");
  now = new Date("2026-09-29T09:00:00Z");
  calls = [];
  ctx = testCtx(t.pool, () => now, {
    fetch: ((url: string) => {
      calls.push(String(url));
      return answer();
    }) as typeof fetch,
  });
});

describe("exchange rates (spec §4.6, R2)", () => {
  it("fetches once a day from open.er-api.com, in rupees per unit, and stores them", async () => {
    answer = ok({ INR: 1, USD: 0.0113122, AED: 0.0415455 });
    expect(await refreshRates(ctx)).toEqual({ ok: true, day: "2026-09-29" });
    expect(calls).toEqual(["https://open.er-api.com/v6/latest/INR"]);
    const r = await currentRates(ctx);
    expect(r.day).toBe("2026-09-29");
    expect(r.ageDays).toBe(0);
    expect(r.rates.USD).toBeCloseTo(88.4, 1);
    expect(r.rates.AED).toBeCloseTo(24.07, 2);
    expect(r.rates.INR).toBe(1);
    // Already have today's: no second fetch.
    await refreshRates(ctx);
    expect(calls).toHaveLength(1);
  });

  it("when the fetch fails, the last rates stand and say how old they are", async () => {
    answer = ok({ INR: 1, USD: 0.0113122 });
    await refreshRates(ctx);
    now = new Date("2026-10-02T09:00:00Z");
    answer = () => Promise.reject(new Error("offline"));
    expect(await refreshRates(ctx)).toMatchObject({ ok: false });
    answer = () => Promise.resolve(new Response("<html>", { status: 502 }));
    expect(await refreshRates(ctx)).toMatchObject({ ok: false });
    answer = ok({ INR: 1, USD: -3 });
    expect(await refreshRates(ctx)).toMatchObject({ ok: false });
    const r = await currentRates(ctx);
    expect(r.day).toBe("2026-09-29");
    expect(r.ageDays).toBe(3);
    expect(r.rates.USD).toBeCloseTo(88.4, 1);
  });

  it("no rates ever fetched: rupees only, and it says so", async () => {
    const r = await currentRates(ctx);
    expect(r).toEqual({ day: null, ageDays: null, rates: { INR: 1 } });
  });

  it("a payment's day uses the rates of that day or the last day before it", async () => {
    await t.pool.query(
      "INSERT INTO fx_rates (day, currency, rate_to_inr) VALUES ('2026-09-01', 'USD', 86), ('2026-09-20', 'USD', 88)",
    );
    expect((await currentRates(ctx, "2026-09-10")).rates.USD).toBe(86);
    expect((await currentRates(ctx)).rates.USD).toBe(88);
  });
});
