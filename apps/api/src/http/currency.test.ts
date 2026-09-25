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
