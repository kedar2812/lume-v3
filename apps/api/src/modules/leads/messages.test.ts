import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SALES_GRANTS } from "../../../test/grants";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
});
afterAll(async () => h.close());

const prepare = (c: AuthedClient, id: string, payload: object = {}) =>
  c.inject({ method: "POST", url: `/api/v1/leads/${id}/messages/prepare`, payload });

describe("WhatsApp hand-off (report §11.2)", () => {
  it("builds a wa.me link server-side, logs it, and never needs the caller to see the number", async () => {
    const seller = await h.seedUser({ grants: SALES_GRANTS });
    const id = await h.seedLead({ ownerId: seller.id, phone: "+971501234567" });
    const c = await h.signIn(seller);
    const res = await prepare(c, id, { text: "Hi Aisha & team — 20% off?" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json().url).toBe(
      "https://wa.me/971501234567?text=Hi%20Aisha%20%26%20team%20%E2%80%94%2020%25%20off%3F",
    );
    const acts = (await c.inject({ method: "GET", url: `/api/v1/leads/${id}/activities` })).json().items;
    expect(acts[0]).toMatchObject({
      type: "whatsapp_opened",
      payload: { text: "Hi Aisha & team — 20% off?" },
    });
    const audit = await h.queryAll(
      "SELECT 1 FROM audit_log WHERE action = 'lead.whatsapp.prepare' AND entity_id = $1",
      [id],
    );
    expect(audit).toHaveLength(1);
  });

  it("explains a lead without a usable number", async () => {
    const seller = await h.seedUser({ grants: SALES_GRANTS });
    const c = await h.signIn(seller);
    const none = await h.seedLead({ ownerId: seller.id });
    const local = await h.seedLead({
      ownerId: seller.id,
      phoneRaw: "0501234567",
      phoneStatus: "needs_country",
    });
    expect((await prepare(c, none)).json().error.code).toBe("NO_WHATSAPP_NUMBER");
    expect((await prepare(c, local)).json().error.code).toBe("PHONE_NEEDS_COUNTRY");
  });

  it("is refused on someone else's lead, and records the Sent? answer", async () => {
    const seller = await h.seedUser({ grants: SALES_GRANTS });
    const other = await h.seedUser({ grants: SALES_GRANTS });
    const c = await h.signIn(seller);
    const theirs = await h.seedLead({ ownerId: other.id, phone: "+971501234567" });
    expect((await prepare(c, theirs)).statusCode).toBe(404);
    const mine = await h.seedLead({ ownerId: seller.id, phone: "+971501234567" });
    const r = await c.inject({
      method: "POST",
      url: `/api/v1/leads/${mine}/messages/confirm`,
      payload: { sent: true },
    });
    expect(r.statusCode).toBe(204);
    const acts = (await c.inject({ method: "GET", url: `/api/v1/leads/${mine}/activities` })).json().items;
    expect(acts[0].type).toBe("whatsapp_confirmed_sent");
  });
});
