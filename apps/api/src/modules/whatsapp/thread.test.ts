import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { echo, inbound } from "../../../../../packages/core/src/whatsapp/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";

/** A lead's WhatsApp thread for the drawer (spec 2026-10-18 §4.2; plan W1 Task 10). */
let h: Harness;
let rep: { id: string; email: string; password: string };
let other: { id: string; email: string; password: string };
beforeAll(async () => {
  h = await createHarness({
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: "http://127.0.0.1:9", version: "v23.0" },
  });
  const admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: false });
  other = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: false });
  await seedNumber(h, { runAs: admin.id, owner: rep.id });
});
afterAll(() => h.close());

describe("GET /api/v1/leads/:id/whatsapp", () => {
  it("the lead's messages, oldest first, each in or out, with its file when there is one", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: "+919876543210" });
    await deliver(h, inbound({ id: "wamid.T1", at: "2026-10-21T06:00:00Z" }));
    await deliver(h, echo({ id: "wamid.T2", at: "2026-10-21T06:05:00Z" }));
    await deliver(
      h,
      inbound({
        id: "wamid.T3",
        at: "2026-10-21T06:10:00Z",
        type: "image",
        image: { id: "M1", mime_type: "image/jpeg" },
      }),
    );
    await h.runWhatsApp();
    const r = await (await h.signIn(rep)).inject({ method: "GET", url: `/api/v1/leads/${lead}/whatsapp` });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.on).toBe(true);
    expect(
      body.messages.map((m: { direction: string; text: string | null }) => [m.direction, m.text]),
    ).toEqual([
      ["in", "Yes, Saturday works"],
      ["out", "See you Saturday"],
      ["in", null],
    ]);
    expect(body.messages[2].media).toEqual({
      id: expect.any(String),
      kind: "image",
      mime: "image/jpeg",
      filename: null,
      voice: false,
    });
  });

  it("a long chat shows its newest 500 messages, oldest first: never the oldest 500 with today's hidden", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Long Chat", phone: "+919876500999" });
    await h.queryAll(
      `INSERT INTO activities (id, lead_id, type, payload, occurred_at)
       SELECT gen_random_uuid(), $1, 'whatsapp_received', jsonb_build_object('text', 'message ' || g),
              timestamptz '2026-10-01T00:00:00Z' + make_interval(mins => g)
         FROM generate_series(1, 520) g`,
      [lead],
    );
    const r = await (await h.signIn(rep)).inject({ method: "GET", url: `/api/v1/leads/${lead}/whatsapp` });
    const texts = (r.json().messages as { text: string }[]).map((m) => m.text);
    expect(texts).toHaveLength(500);
    expect(texts[0]).toBe("message 21");
    expect(texts.at(-1)).toBe("message 520");
  });

  it("someone who can't see the lead gets 404", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Private", phone: "+919000000123" });
    expect(
      (await (await h.signIn(other)).inject({ method: "GET", url: `/api/v1/leads/${lead}/whatsapp` }))
        .statusCode,
    ).toBe(404);
  });
});
