import { randomUUID } from "node:crypto";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../test/harness";

let h: Harness;
let admin: AuthedClient;

beforeAll(async () => {
  h = await createHarness({ preset: "coaching" }); // the business currency is AED
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
});
afterAll(async () => h.close());

describe("one currency across LUME, set in Settings", () => {
  it("refuses a lead or a product in another currency, and takes the business one", async () => {
    const lead = (currency: string) =>
      admin.inject({ method: "POST", url: "/api/v1/leads", payload: { name: "Money", value: 10, currency } });
    const usd = await lead("USD");
    expect(usd.statusCode).toBe(400);
    expect(usd.json().error.code).toBe("ONE_CURRENCY");
    expect((await lead("AED")).statusCode).toBe(201);

    const product = (currency: string) =>
      admin.inject({
        method: "POST",
        url: "/api/v1/products",
        payload: { name: `P ${currency}`, defaultValue: 1, currency },
      });
    expect((await product("INR")).json().error.code).toBe("ONE_CURRENCY");
    expect((await product("AED")).statusCode).toBe(201);
  });

  it("keeps the business currency and country to real codes", async () => {
    const settings = (body: object) =>
      admin.inject({ method: "PATCH", url: "/api/v1/settings", payload: body });
    expect((await settings({ currency: "ZZZ" })).statusCode).toBe(400);
    expect((await settings({ defaultCountry: "ZZ" })).statusCode).toBe(400);
    expect((await settings({ defaultCountry: "IN" })).statusCode).toBe(200);
  });

  it("quotes a switch with what it will touch, and converts every amount once at the confirmed rate", async () => {
    const lead = (
      await admin.inject({
        method: "POST",
        url: "/api/v1/leads",
        payload: { name: "Converted", value: 1000 },
      })
    ).json().lead;
    const product = (
      await admin.inject({
        method: "POST",
        url: "/api/v1/products",
        payload: { name: "Converted pkg", defaultValue: 500 },
      })
    ).json().product;
    const q = await admin.inject({ method: "GET", url: "/api/v1/settings/currency/quote?to=USD" });
    expect(q.statusCode, q.body).toBe(200);
    expect(q.json()).toMatchObject({ from: "AED", to: "USD", rate: 0.27, source: "fixed" });
    expect(q.json().affected.leads).toBeGreaterThanOrEqual(1);
    expect(q.json().affected.products).toBeGreaterThanOrEqual(1);

    const sw = await admin.inject({
      method: "POST",
      url: "/api/v1/settings/currency",
      payload: { from: "AED", to: "USD", rate: 0.27 },
    });
    expect(sw.statusCode, sw.body).toBe(200);
    expect(sw.json().currency).toBe("USD");

    // A second click (or a second admin) never converts twice.
    const again = await admin.inject({
      method: "POST",
      url: "/api/v1/settings/currency",
      payload: { from: "AED", to: "USD", rate: 0.27 },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("CURRENCY_CHANGED");

    const after = (await admin.inject({ method: "GET", url: `/api/v1/leads/${lead.id}` })).json().lead;
    expect(after.value).toBe(270);
    expect(after.version).toBe(lead.version + 1); // an open editor's stale save is refused, not applied
    const products = (await admin.inject({ method: "GET", url: "/api/v1/products" })).json().products;
    expect(products.find((p: { id: string }) => p.id === product.id).defaultValue).toBe(135);
    expect((await admin.inject({ method: "GET", url: "/api/v1/settings" })).json().currency).toBe("USD");

    // Switch back so the other tests keep AED.
    const back = await admin.inject({
      method: "POST",
      url: "/api/v1/settings/currency",
      payload: { from: "USD", to: "AED", rate: 3.7 },
    });
    expect(back.statusCode).toBe(200);
  });

  it("converts every amount there is: binned leads, a source's spend, revenue goals, won value in Analytics; the codes follow (review D4, D5)", async () => {
    const binned = (
      await admin.inject({
        method: "POST",
        url: "/api/v1/leads",
        payload: { name: "In the bin", value: 1000 },
      })
    ).json().lead;
    await h.queryAll("UPDATE leads SET deleted_at = now(), currency = 'AED' WHERE id = $1", [binned.id]);
    const source = randomUUID();
    await h.ownerPool.query(
      "INSERT INTO lead_sources (id, type, name, monthly_spend) VALUES ($1, 'manual', 'Spend test', 2000)",
      [source],
    );
    const revenue = randomUUID();
    const won = randomUUID();
    await h.ownerPool.query(
      `INSERT INTO goals (id, scope, metric, period, period_start, target)
       VALUES ($1, 'business', 'revenue', 'month', '2026-10-01', 10000), ($2, 'business', 'won', 'month', '2026-10-01', 5)`,
      [revenue, won],
    );
    await h.ownerPool.query(
      `INSERT INTO analytics_daily_event (day, source_id, won, won_value, won_no_value, lost, booked, held, no_show,
         cancelled, tasks_due, tasks_done, tasks_on_time, late_minutes_sum, late_count, sends, replies72)
       VALUES ('2026-10-02', $1, 1, 4000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)`,
      [source],
    );
    const product = (
      await admin.inject({
        method: "POST",
        url: "/api/v1/products",
        payload: { name: "Coded pkg", defaultValue: 100 },
      })
    ).json().product;
    await h.ownerPool.query("UPDATE products SET currency = 'AED' WHERE id = $1", [product.id]);

    const sw = await admin.inject({
      method: "POST",
      url: "/api/v1/settings/currency",
      payload: { from: "AED", to: "USD", rate: 0.27 },
    });
    expect(sw.statusCode, sw.body).toBe(200);
    try {
      // Undo from the bin brings it back in the business's currency, not the old one.
      expect(
        await h.queryAll("SELECT value::float AS value, currency FROM leads WHERE id = $1", [binned.id]),
      ).toEqual([{ value: 270, currency: "USD" }]);
      const one = async (q: string, p: unknown[]) => (await h.ownerPool.query(q, p)).rows[0];
      expect(await one("SELECT monthly_spend::float AS v FROM lead_sources WHERE id = $1", [source])).toEqual(
        { v: 540 },
      );
      expect(await one("SELECT target::float AS v FROM goals WHERE id = $1", [revenue])).toEqual({ v: 2700 });
      expect(await one("SELECT target::float AS v FROM goals WHERE id = $1", [won])).toEqual({ v: 5 });
      expect(
        await one("SELECT won_value::float AS v FROM analytics_daily_event WHERE source_id = $1", [source]),
      ).toEqual({ v: 1080 });
      expect(await one("SELECT currency FROM products WHERE id = $1", [product.id])).toEqual({
        currency: "USD",
      });
    } finally {
      const back = await admin.inject({
        method: "POST",
        url: "/api/v1/settings/currency",
        payload: { from: "USD", to: "AED", rate: 3.7 },
      });
      expect(back.statusCode).toBe(200);
      await h.ownerPool.query("DELETE FROM analytics_daily_event WHERE source_id = $1", [source]);
      await h.ownerPool.query("DELETE FROM goals WHERE id = ANY($1)", [[revenue, won]]);
    }
  });

  it("refuses to quote or switch to the current currency, a made-up one, or a silly rate", async () => {
    expect(
      (await admin.inject({ method: "GET", url: "/api/v1/settings/currency/quote?to=AED" })).json().error
        .code,
    ).toBe("SAME_CURRENCY");
    expect(
      (await admin.inject({ method: "GET", url: "/api/v1/settings/currency/quote?to=ZZZ" })).statusCode,
    ).toBe(400);
    for (const rate of [0, -1, 1e7])
      expect(
        (
          await admin.inject({
            method: "POST",
            url: "/api/v1/settings/currency",
            payload: { from: "AED", to: "USD", rate },
          })
        ).statusCode,
      ).toBe(400);
  });

  it("says plainly when live rates can't be had, so the admin can type one", async () => {
    const q = await admin.inject({ method: "GET", url: "/api/v1/settings/currency/quote?to=INR" }); // not in the table
    expect(q.statusCode).toBe(502);
    expect(q.json().error.code).toBe("RATES_UNAVAILABLE");
  });

  it("changes the currency only through the switch", async () => {
    const r = await admin.inject({ method: "PATCH", url: "/api/v1/settings", payload: { currency: "EUR" } });
    expect(r.json().error.code).toBe("USE_DEDICATED_ENDPOINT");
  });

  it("keeps currency switching to people who manage settings", async () => {
    const rep = await h.signIn(await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] }));
    expect(
      (await rep.inject({ method: "GET", url: "/api/v1/settings/currency/quote?to=USD" })).statusCode,
    ).toBe(403);
  });
});
