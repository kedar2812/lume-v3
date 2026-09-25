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
});
