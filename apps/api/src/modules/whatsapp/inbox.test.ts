import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inbound } from "../../../../../packages/core/src/whatsapp/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { sweepWhatsApp } from "./inbox";

/** Not a lead yet (spec 2026-10-18 §4.1; plan W1 Task 7): strangers wait 14 days; a person decides. */
let h: Harness;
let admin: { id: string; email: string; password: string };
let rep: { id: string; email: string; password: string };
let mate: { id: string; email: string; password: string };
let numberId: string;
const STRANGER = "+919000000777";

const stranger = async (id: string, text = "Hi, do you do kitchens?", from = "919000000777") => {
  expect(
    (
      await deliver(
        h,
        inbound({
          from,
          name: "Ravi K",
          id,
          at: h.clock.now.toISOString(),
          type: "text",
          text: { body: text },
        }),
      )
    ).statusCode,
  ).toBe(200);
  await h.runWhatsApp();
};
const inbox = async (u = rep) =>
  (await (await h.signIn(u)).inject({ method: "GET", url: "/api/v1/whatsapp/inbox" })).json();

beforeAll(async () => {
  h = await createHarness({
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: "http://127.0.0.1:9", version: "v23.0" },
  });
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  const own = [
    { key: "leads.view" as const, scope: "own" as const },
    { key: "leads.create" as const, scope: null },
    { key: "leads.edit" as const, scope: "own" as const },
  ];
  rep = await h.seedUser({ grants: own, totp: false });
  mate = await h.seedUser({ grants: own, totp: false });
});
afterAll(() => h.close());
beforeEach(async () => {
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  await h.ownerPool.query("TRUNCATE whatsapp_events");
  // A lead made from a stranger in one test would take their messages in the next.
  await h.queryAll("UPDATE leads SET deleted_at = now() WHERE deleted_at IS NULL");
  h.whatsappQueued.length = 0;
  numberId = await seedNumber(h, { runAs: admin.id, owner: rep.id });
});

describe("Not a lead yet", () => {
  it("one row per person, newest first, with their latest line; only the number's owner (and admins) see it", async () => {
    await stranger("wamid.N1", "Hi, do you do kitchens?");
    h.clock.advance(60_000);
    await stranger("wamid.N2", "And wardrobes?");
    expect(await inbox()).toEqual({
      people: [
        {
          peer: STRANGER,
          name: "Ravi K",
          number: { id: numberId, display: "+91 90000 00001" },
          count: 2,
          lastText: "And wardrobes?",
          lastAt: expect.any(String),
        },
      ],
    });
    expect((await inbox(mate)).people).toEqual([]);
    expect((await inbox(admin)).people).toHaveLength(1);
  });

  it("one person's messages, oldest first", async () => {
    await stranger("wamid.N3", "First");
    await stranger("wamid.N4", "Second");
    const r = await (
      await h.signIn(rep)
    ).inject({ method: "GET", url: `/api/v1/whatsapp/inbox/${numberId}/${encodeURIComponent(STRANGER)}` });
    expect(r.json().messages.map((m: { text: string }) => m.text)).toEqual(["First", "Second"]);
  });

  it("Make it an enquiry: a lead with their name, number and messages, owned like the number; Not a lead yet is empty after", async () => {
    await stranger("wamid.N5", "Hi, do you do kitchens?");
    const r = await (
      await h.signIn(rep)
    ).inject({
      method: "POST",
      url: `/api/v1/whatsapp/inbox/${numberId}/${encodeURIComponent(STRANGER)}/lead`,
    });
    expect(r.statusCode).toBe(201);
    const leadId = r.json().leadId as string;
    const [lead] = await h.queryAll<{ name: string; phone_e164: string; owner_id: string }>(
      "SELECT name, phone_e164, owner_id FROM leads WHERE id = $1",
      [leadId],
    );
    expect(lead).toEqual({ name: "Ravi K", phone_e164: STRANGER, owner_id: rep.id });
    expect(
      await h.queryAll(
        "SELECT payload->>'text' AS text FROM activities WHERE lead_id = $1 AND type = 'whatsapp_received'",
        [leadId],
      ),
    ).toEqual([{ text: "Hi, do you do kitchens?" }]);
    expect((await inbox()).people).toEqual([]);
    const again = await (
      await h.signIn(rep)
    ).inject({
      method: "POST",
      url: `/api/v1/whatsapp/inbox/${numberId}/${encodeURIComponent(STRANGER)}/lead`,
    });
    expect(again.statusCode).toBe(404);
    // What they send next lands on the lead.
    await stranger("wamid.N6", "When can you visit?");
    expect(
      await h.queryAll("SELECT 1 FROM activities WHERE lead_id = $1 AND type = 'whatsapp_received'", [
        leadId,
      ]),
    ).toHaveLength(2);
  });

  it("Not a lead: gone, and that number never shows up again here", async () => {
    await stranger("wamid.N7");
    const r = await (
      await h.signIn(rep)
    ).inject({
      method: "POST",
      url: `/api/v1/whatsapp/inbox/${numberId}/${encodeURIComponent(STRANGER)}/ignore`,
    });
    expect(r.statusCode).toBe(200);
    await stranger("wamid.N8", "Hello?");
    expect((await inbox()).people).toEqual([]);
  });

  it("someone else's number's strangers can't be made into leads or ignored", async () => {
    await stranger("wamid.N9");
    for (const what of ["lead", "ignore"])
      expect(
        (
          await (
            await h.signIn(mate)
          ).inject({
            method: "POST",
            url: `/api/v1/whatsapp/inbox/${numberId}/${encodeURIComponent(STRANGER)}/${what}`,
          })
        ).statusCode,
      ).toBe(404);
  });

  it("kept 14 days, then deleted; processed events forgotten after 30", async () => {
    await stranger("wamid.N10");
    await h.queryAll("UPDATE whatsapp_inbox SET created_at = now() - interval '13 days 23 hours'");
    await sweepWhatsApp(h.ownerPool);
    expect((await inbox()).people).toHaveLength(1);
    await h.queryAll("UPDATE whatsapp_inbox SET created_at = now() - interval '14 days 1 minute'");
    await sweepWhatsApp(h.ownerPool);
    expect((await inbox()).people).toEqual([]);
    await h.ownerPool.query("UPDATE whatsapp_events SET received_at = now() - interval '31 days'");
    await sweepWhatsApp(h.ownerPool);
    expect((await h.ownerPool.query("SELECT count(*) FROM whatsapp_events")).rows[0].count).toBe("0");
  });

  it("a stranger's photo stays a photo on the lead it becomes", async () => {
    expect(
      (
        await deliver(
          h,
          inbound({
            from: "919000000777",
            name: "Ravi K",
            id: "wamid.P9",
            at: h.clock.now.toISOString(),
            type: "image",
            image: { id: "MP9", mime_type: "image/jpeg" },
          }),
        )
      ).statusCode,
    ).toBe(200);
    await h.runWhatsApp();
    const r = await (
      await h.signIn(rep)
    ).inject({
      method: "POST",
      url: `/api/v1/whatsapp/inbox/${numberId}/${encodeURIComponent(STRANGER)}/lead`,
    });
    const leadId = r.json().leadId as string;
    const thread = (
      await (await h.signIn(rep)).inject({ method: "GET", url: `/api/v1/leads/${leadId}/whatsapp` })
    ).json();
    expect(thread.messages[0].media).toEqual({
      id: expect.any(String),
      kind: "image",
      mime: "image/jpeg",
      filename: null,
      voice: false,
    });
  });
});
