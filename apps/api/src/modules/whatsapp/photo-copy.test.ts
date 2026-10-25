import { randomUUID } from "node:crypto";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inbound } from "../../../../../packages/core/src/whatsapp/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";

/**
 * Photos up to 20 MB (owner, 2026-10-25): LUME keeps the photo as it was given; WhatsApp takes photos up to 5 MB, so a
 * bigger one goes out as a copy that fits, made by the render service, or as a document when there's no copy.
 */
let h: Harness;
let meta: MetaFake;
type U = { id: string; email: string; password: string };
let admin: U;
const SNEHA = "+919876543210";
const MB = 1024 * 1024;
/** A PNG's signature and then its size: LUME reads what a file is from its first bytes. */
const png = (size: number) => {
  const b = Buffer.alloc(size, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  return b;
};

const as = (u: U) => h.signIn(u);
async function upload(bytes: Buffer, name: string) {
  return (await as(admin)).inject({
    method: "POST",
    url: "/api/v1/files",
    headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) },
    payload: bytes,
  });
}
async function sendFile(lead: string, fileId: string) {
  const a = await (
    await as(admin)
  ).inject({ method: "POST", url: `/api/v1/leads/${lead}/whatsapp/files/library`, payload: { fileId } });
  expect(a.statusCode, a.body).toBe(201);
  const r = await (
    await as(admin)
  ).inject({
    method: "POST",
    url: `/api/v1/leads/${lead}/whatsapp/messages`,
    payload: { clientKey: randomUUID(), mediaId: a.json().media.id },
  });
  expect(r.statusCode, r.body).toBe(202);
  await h.runWhatsAppSend();
}
async function lead() {
  const id = await h.seedLead({ ownerId: admin.id, name: "Sneha Reddy", phone: SNEHA });
  await deliver(
    h,
    structuredClone(
      inbound({ from: SNEHA.slice(1), id: `wamid.${randomUUID()}`, at: h.clock.now.toISOString() }),
    ),
  );
  await h.runWhatsApp();
  return id;
}

beforeAll(async () => {
  meta = await startMetaFake();
  h = await createHarness({
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: meta.url, version: meta.version },
    render: true,
  });
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
});
afterAll(async () => {
  await h.close();
  await meta.close();
});
beforeEach(async () => {
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  await h.ownerPool.query("DELETE FROM message_files");
  await h.queryAll("UPDATE leads SET deleted_at = now() WHERE deleted_at IS NULL");
  meta.sent.length = 0;
  meta.uploads.length = 0;
  h.render!.down = false;
  h.render!.fail = 0;
  h.render!.calls.length = 0;
  h.render!.photoBody = null;
  await seedNumber(h, { runAs: admin.id, owner: admin.id });
  await h.ownerPool.query(
    `UPDATE settings SET integrations = jsonb_set(integrations, '{whatsapp}', '{"enabled": true, "replyFromLume": true}'::jsonb) WHERE id = 1`,
  );
});

describe("a photo up to 20 MB", () => {
  it("is kept as given; over 20 MB is refused in words", async () => {
    const ok = await upload(png(12 * MB), "Kitchen, finished.png");
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().file).toMatchObject({ kind: "image", size: 12 * MB });
    const big = await upload(png(20 * MB + 1), "Too big.png");
    expect(big.statusCode).toBe(413);
    expect(big.json().error.message).toBe("Photos can be up to 20 MB.");
  });

  it("over 5 MB, WhatsApp gets a copy that fits, as a photo", async () => {
    const id = await lead();
    const f = (await upload(png(12 * MB), "Kitchen, finished.png")).json().file;
    await sendFile(id, f.id);
    expect(h.render!.calls.filter((c) => c.path === "/v1/photo")).toHaveLength(1);
    expect(meta.uploads).toHaveLength(1);
    expect(meta.uploads[0]).toMatchObject({ type: "image/jpeg" });
    expect(meta.uploads[0]!.size).toBeLessThan(5 * MB);
    expect(meta.sent[0]!.body.type).toBe("image");
  });

  it("with no copy to be had (the render service down), it goes as a document, whole, not refused", async () => {
    const id = await lead();
    h.render!.down = true;
    const f = (await upload(png(12 * MB), "Kitchen, finished.png")).json().file;
    await sendFile(id, f.id);
    expect(meta.uploads).toHaveLength(1);
    expect(meta.uploads[0]).toMatchObject({ type: "image/png" });
    expect(meta.uploads[0]!.size).toBeGreaterThan(12 * MB);
    expect(meta.sent[0]!.body).toMatchObject({
      type: "document",
      document: { filename: "Kitchen, finished.png" },
    });
  });

  it("a copy that isn't a JPEG, or doesn't fit, is never sent: the photo goes whole, as a document", async () => {
    const id = await lead();
    h.render!.photoBody = png(1024);
    const f = (await upload(png(12 * MB), "Kitchen, finished.png")).json().file;
    await sendFile(id, f.id);
    expect(meta.uploads[0]).toMatchObject({ type: "image/png" });
    expect(meta.sent[0]!.body.type).toBe("document");
  });

  it("5 MB or under goes as it is: no copy made", async () => {
    const id = await lead();
    const f = (await upload(png(4 * MB), "Office.png")).json().file;
    await sendFile(id, f.id);
    expect(h.render!.calls.filter((c) => c.path === "/v1/photo")).toHaveLength(0);
    expect(meta.uploads[0]).toMatchObject({ type: "image/png" });
    expect(meta.sent[0]!.body.type).toBe("image");
  });
});
