import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
let admin: AuthedClient;
beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
});
afterAll(async () => h.close());

describe("lost reasons, tags, products", () => {
  it("lost reasons come from the preset and can be added, renamed and archived", async () => {
    const list = (await admin.inject({ method: "GET", url: "/api/v1/lost-reasons" })).json().lostReasons;
    expect(list.map((r: { label: string }) => r.label)[0]).toBe("Not interested");
    const r = (
      await admin.inject({ method: "POST", url: "/api/v1/lost-reasons", payload: { label: "Moved away" } })
    ).json().lostReason;
    await admin.inject({
      method: "PATCH",
      url: `/api/v1/lost-reasons/${r.id}`,
      payload: { label: "Relocated" },
    });
    expect(
      (await admin.inject({ method: "POST", url: `/api/v1/lost-reasons/${r.id}/archive` })).statusCode,
    ).toBe(204);
    const after = (await admin.inject({ method: "GET", url: "/api/v1/lost-reasons" })).json().lostReasons;
    expect(after.some((x: { label: string }) => x.label === "Relocated")).toBe(false);
  });

  it("tags are unique case-insensitively and deletable", async () => {
    const t = (
      await admin.inject({ method: "POST", url: "/api/v1/tags", payload: { label: "VIP", color: "warn" } })
    ).json().tag;
    expect(
      (await admin.inject({ method: "POST", url: "/api/v1/tags", payload: { label: "vip" } })).statusCode,
    ).toBe(409);
    expect((await admin.inject({ method: "DELETE", url: `/api/v1/tags/${t.id}` })).statusCode).toBe(204);
  });

  it("products carry an optional default value, in the business currency", async () => {
    const p = (
      await admin.inject({
        method: "POST",
        url: "/api/v1/products",
        payload: { name: "12-week program", defaultValue: 4500, currency: "AED" },
      })
    ).json().product;
    expect(p).toMatchObject({ name: "12-week program", defaultValue: 4500, currency: null });
    expect((await admin.inject({ method: "POST", url: `/api/v1/products/${p.id}/archive` })).statusCode).toBe(
      204,
    );
  });

  it("anyone who can see leads can read the lists; only managers can change them", async () => {
    const rep = await h.signIn(await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] }));
    expect((await rep.inject({ method: "GET", url: "/api/v1/tags" })).statusCode).toBe(200);
    expect(
      (await rep.inject({ method: "POST", url: "/api/v1/tags", payload: { label: "Nope" } })).statusCode,
    ).toBe(403);
  });
});
