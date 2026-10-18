import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inbound } from "../../../../../packages/core/src/whatsapp/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";

/** Photos, voice notes and files: fetched to this server, shown with their lead (spec 2026-10-18 §4.1; W1 Task 7). */
let h: Harness;
let meta: MetaFake;
let admin: { id: string; email: string; password: string };
let rep: { id: string; email: string; password: string };
let other: { id: string; email: string; password: string };
const SNEHA = "+919876543210";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const mediaOf = (lead: string) =>
  h.queryAll<{ id: string; status: string; problem: string | null; size: number | null }>(
    "SELECT id, status, problem, size FROM whatsapp_media WHERE lead_id = $1",
    [lead],
  );
async function photoOn(lead: string, metaId: string, bytes: Buffer = JPEG, o: Record<string, unknown> = {}) {
  meta.media.set(metaId, { mime: "image/jpeg", bytes });
  expect(
    (
      await deliver(
        h,
        inbound({
          id: `wamid.${metaId}`,
          type: "image",
          image: { id: metaId, mime_type: "image/jpeg" },
          ...o,
        }),
      )
    ).statusCode,
  ).toBe(200);
  await h.runWhatsApp();
  return (await mediaOf(lead))[0]!;
}

beforeAll(async () => {
  meta = await startMetaFake();
  h = await createHarness({
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: meta.url, version: meta.version },
  });
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: false });
  other = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: false });
});
afterAll(async () => {
  await h.close();
  await meta.close();
});
beforeEach(async () => {
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  await h.queryAll("UPDATE leads SET deleted_at = now() WHERE deleted_at IS NULL");
  h.whatsappQueued.length = 0;
  h.whatsappMediaQueued.length = 0;
  meta.revoked.clear();
  await seedNumber(h, { runAs: admin.id, owner: rep.id });
});

describe("fetching", () => {
  it("a photo is fetched with the number's token, kept, and shown to whoever sees the lead", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const m = await photoOn(lead, "M1");
    await h.runWhatsAppMedia();
    expect(await mediaOf(lead)).toEqual([{ id: m.id, status: "ready", problem: null, size: JPEG.length }]);
    const r = await (await h.signIn(rep)).inject({ method: "GET", url: `/api/v1/whatsapp/media/${m.id}` });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/jpeg");
    expect(r.headers["content-disposition"]).toMatch(/^inline/);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.rawPayload.equals(JPEG)).toBe(true);
    const info = await (
      await h.signIn(rep)
    ).inject({ method: "GET", url: `/api/v1/whatsapp/media/${m.id}/info` });
    expect(info.json()).toEqual({
      status: "ready",
      problem: null,
      kind: "image",
      mime: "image/jpeg",
      filename: null,
      size: JPEG.length,
      voice: false,
    });
  });

  it("someone who can't see the lead can't see its media", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const m = await photoOn(lead, "M2");
    await h.runWhatsAppMedia();
    expect(
      (await (await h.signIn(other)).inject({ method: "GET", url: `/api/v1/whatsapp/media/${m.id}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await (await h.signIn(other)).inject({ method: "GET", url: `/api/v1/whatsapp/media/${m.id}/info` }))
        .statusCode,
    ).toBe(404);
  });

  it("a document is a download, with its own name", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    meta.media.set("D1", { mime: "application/pdf", bytes: Buffer.from("%PDF-1.4") });
    await deliver(
      h,
      inbound({
        id: "wamid.D1",
        type: "document",
        document: { id: "D1", mime_type: "application/pdf", filename: "Floor plan.pdf" },
      }),
    );
    await h.runWhatsApp();
    await h.runWhatsAppMedia();
    const [m] = await mediaOf(lead);
    const r = await (await h.signIn(rep)).inject({ method: "GET", url: `/api/v1/whatsapp/media/${m!.id}` });
    expect(r.headers["content-disposition"]).toBe(
      `attachment; filename="Floor plan.pdf"; filename*=UTF-8''Floor%20plan.pdf`,
    );
  });

  it("over 25 MB: not kept, and said in words", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await photoOn(lead, "BIG", Buffer.alloc(25 * 1024 * 1024 + 1));
    await h.runWhatsAppMedia();
    expect(await mediaOf(lead)).toEqual([
      expect.objectContaining({
        status: "too_large",
        problem: "This file is over 25 MB. Open it on the phone.",
      }),
    ]);
  });

  it("Review Focus 4: a token WhatsApp stopped accepting — the number says Reconnect, the photo waits and says why, texts still arrive", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await photoOn(lead, "M3");
    meta.revoked.add("EAAG-business-token");
    await h.runWhatsAppMedia();
    expect((await h.ownerPool.query("SELECT status, problem FROM whatsapp_numbers")).rows[0]).toEqual({
      status: "needs_attention",
      problem: "WhatsApp stopped letting LUME in. Connect this number again.",
    });
    expect(await mediaOf(lead)).toEqual([
      expect.objectContaining({
        status: "waiting",
        problem: "Waiting for this number to be connected again.",
      }),
    ]);
    await deliver(h, inbound({ id: "wamid.T9", text: { body: "Still there?" }, type: "text" }));
    await h.runWhatsApp();
    expect(
      await h.queryAll("SELECT 1 FROM activities WHERE lead_id = $1 AND payload->>'wamid' = 'wamid.T9'", [
        lead,
      ]),
    ).toHaveLength(1);
  });

  it("WhatsApp no longer has it: failed, said in words", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await photoOn(lead, "M4");
    meta.media.delete("M4");
    await h.runWhatsAppMedia();
    expect(await mediaOf(lead)).toEqual([
      expect.objectContaining({ status: "failed", problem: "WhatsApp no longer has this file." }),
    ]);
  });
});
