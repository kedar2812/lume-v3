import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  const [m] = await h.queryAll<{ id: string; status: string; problem: string | null; size: number | null }>(
    "SELECT id, status, problem, size FROM whatsapp_media WHERE lead_id = $1 AND meta_id = $2",
    [lead, metaId],
  );
  return m!;
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
  // Media went with their numbers; their files go too, from the table and the disk.
  await h.ownerPool.query("DELETE FROM whatsapp_files");
  await h.ownerPool.query("DELETE FROM whatsapp_files_gone");
  for (const f of (await h.files.store.scan()).files) await h.files.store.remove(f.sha256);
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

/** Files out of the database (2026-10-19): kept once on disk, served from it, and every way that can go wrong. */
describe("files on disk", () => {
  const filesRows = () =>
    h.queryAll<{ sha256: string; refs: number; size: string }>(
      "SELECT sha256, refs, size FROM whatsapp_files",
    );
  const get = async (id: string, headers: Record<string, string> = {}) =>
    (await h.signIn(rep)).inject({ method: "GET", url: `/api/v1/whatsapp/media/${id}`, headers });

  it("the same brochure to two leads is one file on disk, pointed at twice, served the same to both", async () => {
    const a = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const b = await h.seedLead({ ownerId: rep.id, name: "Karan Mehta", phone: "+919876500011" });
    const ma = await photoOn(a, "SAME1");
    const mb = await photoOn(b, "SAME2", JPEG, { from: "919876500011" });
    await h.runWhatsAppMedia();
    const rows = await filesRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ refs: 2, size: String(JPEG.length) });
    expect((await h.files.store.scan()).files.map((f) => f.sha256)).toEqual([rows[0]!.sha256]);
    for (const m of [ma, mb]) expect((await get(m.id)).rawPayload.equals(JPEG)).toBe(true);
  });

  it("a file the disk no longer has says so in words, and the file itself is a 404 with them", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const m = await photoOn(lead, "GONE1");
    await h.runWhatsAppMedia();
    await h.files.store.remove((await filesRows())[0]!.sha256);
    const info = await (
      await h.signIn(rep)
    ).inject({ method: "GET", url: `/api/v1/whatsapp/media/${m.id}/info` });
    expect(info.json()).toMatchObject({
      status: "missing",
      problem: "This file isn't on the server any more. It's still on the phone.",
    });
    const r = await get(m.id);
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toEqual({
      code: "MEDIA_MISSING",
      message: "This file isn't on the server any more. It's still on the phone.",
    });
  });

  it("video and voice notes seek: one byte range is a 206, a bad one a 416, a repeat view a 304", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const m = await photoOn(lead, "RANGE1", Buffer.from("0123456789"));
    await h.runWhatsAppMedia();
    const part = await get(m.id, { range: "bytes=2-5" });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe("bytes 2-5/10");
    expect(part.payload).toBe("2345");
    const tail = await get(m.id, { range: "bytes=-3" });
    expect([tail.statusCode, tail.payload]).toEqual([206, "789"]);
    const open = await get(m.id, { range: "bytes=7-" });
    expect([open.statusCode, open.payload]).toEqual([206, "789"]);
    for (const bad of ["bytes=10-", "bytes=0-1,3-4", "bytes=5-2", "items=0-1", "bytes=-0"]) {
      const r = await get(m.id, { range: bad });
      expect([bad, r.statusCode, r.headers["content-range"]]).toEqual([bad, 416, "bytes */10"]);
    }
    const whole = await get(m.id);
    expect([whole.statusCode, whole.headers["content-length"], whole.headers["accept-ranges"]]).toEqual([
      200,
      "10",
      "bytes",
    ]);
    const again = await get(m.id, { "if-none-match": String(whole.headers.etag) });
    expect(again.statusCode).toBe(304);
  });

  it("security: a stranger's SVG, HTML or unknown file never shows as a page of LUME's", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const cases = [
      {
        id: "SVG",
        kind: "image",
        mime: "image/svg+xml",
        type: "application/octet-stream",
        disp: /^attachment/,
      },
      {
        id: "HTML",
        kind: "document",
        mime: "text/html",
        type: "application/octet-stream",
        disp: /^attachment/,
      },
      { id: "PDF", kind: "document", mime: "application/pdf", type: "application/pdf", disp: /^attachment/ },
      { id: "VOICE", kind: "audio", mime: "audio/ogg; codecs=opus", type: "audio/ogg", disp: /^inline$/ },
      {
        id: "BADMIME",
        kind: "image",
        mime: "image/png\r\nx-evil: 1",
        type: "application/octet-stream",
        disp: /^attachment/,
      },
    ] as const;
    for (const c of cases) {
      // The type LUME keeps is the one in the webhook (the sender's); Meta's download answers plain bytes.
      meta.media.set(c.id, {
        mime: "application/octet-stream",
        bytes: Buffer.from(`<svg onload=alert(1)>${c.id}`),
      });
      await deliver(
        h,
        inbound({ id: `wamid.${c.id}`, type: c.kind, [c.kind]: { id: c.id, mime_type: c.mime } }),
      );
    }
    await h.runWhatsApp();
    await h.runWhatsAppMedia();
    const rows = await h.queryAll<{ id: string; meta_id: string }>(
      "SELECT id, meta_id FROM whatsapp_media WHERE lead_id = $1",
      [lead],
    );
    for (const c of cases) {
      const m = rows.find((r) => r.meta_id === c.id)!;
      const r = await get(m.id);
      expect([c.id, r.statusCode, r.headers["content-type"]]).toEqual([c.id, 200, c.type]);
      expect(r.headers["content-disposition"]).toMatch(c.disp);
      expect(r.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["x-evil"]).toBeUndefined();
    }
  });

  it("security: a link that isn't Meta's, or a redirect off Meta's hosts, is never fetched with the token", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const away = encodeURIComponent("https://evil.example/steal");
    meta.mediaUrls.set("EVIL1", "https://evil.example/steal");
    meta.mediaUrls.set("EVIL2", `${meta.url}/redirect?to=${away}`);
    meta.mediaUrls.set(
      "OKREDIRECT",
      `${meta.url}/redirect?to=${encodeURIComponent(`${meta.url}/download/OKREDIRECT`)}`,
    );
    for (const id of ["EVIL1", "EVIL2", "OKREDIRECT"]) await photoOn(lead, id);
    await h.runWhatsAppMedia();
    const rows = await h.queryAll<{ meta_id: string; status: string; problem: string | null }>(
      "SELECT meta_id, status, problem FROM whatsapp_media WHERE lead_id = $1 ORDER BY meta_id",
      [lead],
    );
    const untrusted = "LUME didn't fetch this file. WhatsApp sent a link that isn't Meta's.";
    expect(rows).toEqual([
      { meta_id: "EVIL1", status: "failed", problem: untrusted },
      { meta_id: "EVIL2", status: "failed", problem: untrusted },
      { meta_id: "OKREDIRECT", status: "ready", problem: null },
    ]);
  });

  it("a nearly full disk (95%) keeps nothing new and waits 15 minutes without using a try", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const m = await photoOn(lead, "FULL1");
    h.files.setDisk({ total: 100, free: 4 });
    try {
      const calls = meta.calls.length;
      await h.runWhatsAppMedia();
      expect(meta.calls.length).toBe(calls); // Meta wasn't even asked
      const [row] = await h.queryAll<{ status: string; problem: string; tries: number; retry_at: Date }>(
        "SELECT status, problem, tries, retry_at FROM whatsapp_media WHERE id = $1",
        [m.id],
      );
      expect(row).toMatchObject({
        status: "waiting",
        problem: "The server's disk is full. LUME will try again.",
        tries: 0,
      });
      expect(row!.retry_at.getTime() - h.clock.now.getTime()).toBe(15 * 60_000);
      // Room again, but not yet its time: still waits.
      h.files.setDisk({ total: 100, free: 50 });
      h.whatsappMediaQueued.push(m.id);
      await h.runWhatsAppMedia();
      expect((await mediaOf(lead))[0]!.status).toBe("waiting");
      h.clock.advance(15 * 60_000 + 1);
      h.whatsappMediaQueued.push(m.id);
      await h.runWhatsAppMedia();
      expect((await mediaOf(lead))[0]).toMatchObject({ status: "ready", problem: null });
    } finally {
      h.files.setDisk({ total: 100 * 1024 ** 3, free: 60 * 1024 ** 3 });
    }
  });

  it("the disk filling during the write, or a folder LUME can't write: waits with words, no try used", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    for (const [code, words] of [
      ["ENOSPC", "The server's disk is full. LUME will try again."],
      ["EROFS", "LUME can't save files on this server yet. It will try again."],
      ["EACCES", "LUME can't save files on this server yet. It will try again."],
    ] as const) {
      await photoOn(lead, `W-${code}`, Buffer.from(code));
      const [m] = await h.queryAll<{ id: string }>("SELECT id FROM whatsapp_media WHERE meta_id = $1", [
        `W-${code}`,
      ]);
      const spy = vi
        .spyOn(h.files.store, "put")
        .mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      await h.runWhatsAppMedia();
      spy.mockRestore();
      const [row] = await h.queryAll<{ status: string; problem: string; tries: number }>(
        "SELECT status, problem, tries FROM whatsapp_media WHERE id = $1",
        [m!.id],
      );
      expect([code, row]).toEqual([code, { status: "waiting", problem: words, tries: 0 }]);
    }
  });

  it("strangers can't fill the disk: 1 GB a day from numbers no lead has; a file LUME already has costs nothing", async () => {
    // A gigabyte already kept today from strangers.
    const big = "e".repeat(64);
    await h.ownerPool.query("INSERT INTO whatsapp_files (sha256, size) VALUES ($1, $2)", [big, 1024 ** 3]);
    const [n] = await h.queryAll<{ id: string }>("SELECT id FROM whatsapp_numbers");
    await h.queryAll(
      `INSERT INTO whatsapp_media (id, number_id, meta_id, kind, mime, status, sha256, size)
       VALUES (gen_random_uuid(), $1, 'BIGSTRANGER', 'video', 'video/mp4', 'ready', $2, $3)`,
      [n!.id, big, 1024 ** 3],
    );
    // A lead's photo with these bytes is already here.
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await photoOn(lead, "KNOWN", Buffer.from("known bytes"));
    await h.runWhatsAppMedia();
    const stranger = (metaId: string, bytes: Buffer) => {
      meta.media.set(metaId, { mime: "image/jpeg", bytes });
      return deliver(
        h,
        inbound({
          from: "919000000777",
          id: `wamid.${metaId}`,
          type: "image",
          image: { id: metaId, mime_type: "image/jpeg" },
        }),
      );
    };
    await stranger("NEWBYTES", Buffer.from("new bytes from a stranger"));
    await stranger("SAMEBYTES", Buffer.from("known bytes"));
    await h.runWhatsApp();
    await h.runWhatsAppMedia();
    const rows = await h.queryAll<{ meta_id: string; status: string; problem: string | null }>(
      "SELECT meta_id, status, problem FROM whatsapp_media WHERE meta_id IN ('NEWBYTES', 'SAMEBYTES') ORDER BY meta_id",
    );
    expect(rows).toEqual([
      {
        meta_id: "NEWBYTES",
        status: "failed",
        problem: "LUME didn't keep this file. Too many files came today from people who aren't leads.",
      },
      { meta_id: "SAMEBYTES", status: "ready", problem: null },
    ]);
  });
  it("the strangers' cap is for each number: a busy number's day doesn't turn away another number's enquiries", async () => {
    const big = "d".repeat(64);
    await h.ownerPool.query("INSERT INTO whatsapp_files (sha256, size) VALUES ($1, $2)", [big, 1024 ** 3]);
    const other = await seedNumber(h, { runAs: admin.id, owner: rep.id, phoneNumberId: "999999999999" });
    await h.queryAll(
      `INSERT INTO whatsapp_media (id, number_id, meta_id, kind, mime, status, sha256, size)
       VALUES (gen_random_uuid(), $1, 'OTHERBIG', 'video', 'video/mp4', 'ready', $2, $3)`,
      [other, big, 1024 ** 3],
    );
    meta.media.set("MINE", { mime: "image/jpeg", bytes: Buffer.from("an enquiry's photo") });
    await deliver(
      h,
      inbound({
        from: "919000000666",
        id: "wamid.MINE",
        type: "image",
        image: { id: "MINE", mime_type: "image/jpeg" },
      }),
    );
    await h.runWhatsApp();
    await h.runWhatsAppMedia();
    const [row] = await h.queryAll<{ status: string }>(
      "SELECT status FROM whatsapp_media WHERE meta_id = 'MINE'",
    );
    expect(row).toEqual({ status: "ready" });
  });
});
