import { randomUUID } from "node:crypto";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inbound } from "../../../../../packages/core/src/whatsapp/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";

/** Replying to a lead on WhatsApp from LUME (plan W3a Task 3; spec 2026-10-18 §3.4): who may, when, and with what. */
let h: Harness;
let meta: MetaFake;
type U = { id: string; email: string; password: string };
let admin: U;
let rep: U;
let mate: U;
let viewer: U;
let number: string;
const SNEHA = "+919876543210";
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n");

const as = (u: U) => h.signIn(u);
const setReply = async (on: boolean) =>
  (await as(admin)).inject({
    method: "PUT",
    url: "/api/v1/integrations/whatsapp",
    payload: { replyFromLume: on },
  });
const send = async (u: U, lead: string, body: Record<string, unknown>) =>
  (await as(u)).inject({
    method: "POST",
    url: `/api/v1/leads/${lead}/whatsapp/messages`,
    payload: { clientKey: randomUUID(), ...body },
  });
const attach = async (u: U, lead: string, bytes: Buffer, name: string) =>
  (await as(u)).inject({
    method: "POST",
    url: `/api/v1/leads/${lead}/whatsapp/files`,
    headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) },
    payload: bytes,
  });
/** A file in the business's library (W3b-1), uploaded by the admin: its id. */
const libraryFile = async (name: string) =>
  (
    await (
      await as(admin)
    ).inject({
      method: "POST",
      url: "/api/v1/files",
      headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) },
      payload: PDF,
    })
  ).json().file.id as string;
const fromLibrary = async (u: U, lead: string, fileId: string) =>
  (await as(u)).inject({
    method: "POST",
    url: `/api/v1/leads/${lead}/whatsapp/files/library`,
    payload: { fileId },
  });
const thread = async (u: U, lead: string) =>
  (await (await as(u)).inject({ method: "GET", url: `/api/v1/leads/${lead}/whatsapp` })).json();
/** The lead writes on WhatsApp now (the harness's time), to a number. */
async function writes(o: { from?: string; id?: string; phoneNumberId?: string } = {}) {
  // A copy: the fixture's envelope is shared, and changing its number would change every later delivery's.
  const body = structuredClone(
    inbound({
      from: (o.from ?? SNEHA).slice(1),
      id: o.id ?? `wamid.${randomUUID()}`,
      at: h.clock.now.toISOString(),
    }),
  );
  if (o.phoneNumberId)
    (body.entry[0]!.changes[0]!.value as { metadata: { phone_number_id: string } }).metadata.phone_number_id =
      o.phoneNumberId;
  expect((await deliver(h, body)).statusCode).toBe(200);
  await h.runWhatsApp();
}
const outbox = (lead: string) =>
  h.queryAll<{ status: string; text: string | null; user_id: string; number_id: string }>(
    "SELECT status, text, user_id, number_id FROM whatsapp_outbox WHERE lead_id = $1 ORDER BY created_at",
    [lead],
  );

beforeAll(async () => {
  meta = await startMetaFake();
  h = await createHarness({
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: meta.url, version: meta.version },
  });
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  const sender = [
    { key: "leads.view", scope: "own" },
    { key: "messages.send", scope: "own" },
  ] as const;
  rep = await h.seedUser({ grants: [...sender], totp: false });
  mate = await h.seedUser({
    grants: [
      { key: "leads.view", scope: "team" },
      { key: "messages.send", scope: "team" },
    ],
    totp: false,
  });
  viewer = await h.seedUser({ grants: [{ key: "leads.view", scope: "all" }], totp: false });
  await h.seedTeam(mate.id, [rep.id]);
});
afterAll(async () => {
  await h.close();
  await meta.close();
});
beforeEach(async () => {
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  await h.ownerPool.query("DELETE FROM message_files");
  await h.queryAll("UPDATE leads SET deleted_at = now() WHERE deleted_at IS NULL");
  h.whatsappQueued.length = 0;
  h.whatsappMediaQueued.length = 0;
  h.whatsappSendQueued.length = 0;
  number = await seedNumber(h, { runAs: admin.id, owner: rep.id });
  expect((await setReply(true)).statusCode).toBe(200);
});

describe("who may reply, and when", () => {
  it("off by default; switched on by an admin, the switch kept apart from WhatsApp's own", async () => {
    await h.ownerPool.query(
      `UPDATE settings SET integrations = jsonb_set(integrations, '{whatsapp}', '{"enabled": true}'::jsonb) WHERE id = 1`,
    );
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    const r = await send(rep, lead, { text: "Hi" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toEqual({
      code: "REPLY_OFF",
      message: "Replying from LUME is off. An admin can switch it on in Settings → Integrations → WhatsApp.",
    });
    expect((await thread(rep, lead)).reply).toBeNull();
    const on = await setReply(true);
    expect(on.json().whatsapp).toMatchObject({ enabled: true, replyFromLume: true });
    expect(
      (
        await (
          await as(rep)
        ).inject({ method: "PUT", url: "/api/v1/integrations/whatsapp", payload: { replyFromLume: false } })
      ).statusCode,
    ).toBe(403);
    const audit = await h.ownerPool.query<{ diff: unknown }>(
      "SELECT diff FROM audit_log WHERE action = 'integration.updated' ORDER BY at DESC LIMIT 1",
    );
    expect(audit.rows[0]!.diff).toEqual({ module: "whatsapp", replyFromLume: { from: false, to: true } });
  });

  it("someone who can't send messages gets 403; someone who can't see the lead gets 404", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    expect((await send(viewer, lead, { text: "Hi" })).statusCode).toBe(403);
    const other = await h.seedUser({
      grants: [
        { key: "messages.send", scope: "own" },
        { key: "leads.view", scope: "own" },
      ],
      totp: false,
    });
    expect((await send(other, lead, { text: "Hi" })).statusCode).toBe(404);
    expect(await outbox(lead)).toEqual([]);
  });

  it("Review Focus 2: a teammate who sees the lead through the team may reply", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    expect((await send(mate, lead, { text: "Hi from the team" })).statusCode).toBe(202);
    expect(await outbox(lead)).toMatchObject([{ user_id: mate.id, text: "Hi from the team" }]);
  });

  it("only within WhatsApp's 24 hours of the lead's last message, checked when Send is tapped", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const never = await send(rep, lead, { text: "Hi" });
    expect(never.statusCode).toBe(409);
    expect(never.json().error).toEqual({
      code: "WINDOW_CLOSED",
      message:
        "It's been over 24 hours since Sneha's last WhatsApp message. Send it from the phone, or wait for Sneha to write again.",
    });
    expect((await thread(rep, lead)).reply).toMatchObject({ allowed: false, until: null });
    const wrote = h.clock.now.getTime();
    await writes();
    const t = await thread(rep, lead);
    expect(t.reply).toEqual({
      allowed: true,
      number: { id: number, display: "+91 90000 00001", ownerName: expect.any(String) },
      until: new Date(wrote + 24 * 3_600_000).toISOString(),
      reason: null,
    });
    // Review Focus 1: the composer was open all day; when Send is tapped the window has closed.
    h.clock.advance(24 * 3_600_000 + 1000);
    expect((await send(rep, lead, { text: "Still there?" })).json().error.code).toBe("WINDOW_CLOSED");
    expect(await outbox(lead)).toEqual([]);
  });

  it("from the number the lead last wrote to, and never quietly from another when that one needs connecting", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const second = await seedNumber(h, { runAs: admin.id, owner: null, phoneNumberId: "222222222222" });
    await setReply(true); // seeding a number resets WhatsApp's settings
    await writes();
    await writes({ phoneNumberId: "222222222222" });
    expect((await send(rep, lead, { text: "Hi" })).statusCode).toBe(202);
    expect((await outbox(lead))[0]!.number_id).toBe(second);
    await h.ownerPool.query(
      "UPDATE whatsapp_numbers SET status = 'needs_attention', problem = 'x' WHERE id = $1",
      [second],
    );
    const r = await send(rep, lead, { text: "Again" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toEqual({
      code: "NUMBER_NOT_READY",
      message: "Connect +91 90000 00001 again to reply from LUME.",
    });
    expect((await thread(rep, lead)).reply).toMatchObject({
      allowed: false,
      reason: "Connect +91 90000 00001 again to reply from LUME.",
    });
  });
});

describe("sending", () => {
  it("a reply is queued once, shows on the thread as sent by its person, and the same key twice is one message", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    const clientKey = randomUUID();
    const once = await send(rep, lead, { clientKey, text: "  See you Saturday  " });
    const twice = await send(rep, lead, { clientKey, text: "  See you Saturday  " });
    expect(once.statusCode).toBe(202);
    expect(twice.statusCode).toBe(202);
    expect(twice.json().message.id).toBe(once.json().message.id);
    expect(once.json().message).toMatchObject({
      direction: "out",
      text: "  See you Saturday  ",
      status: "queued",
      problem: null,
      sentBy: { id: rep.id, name: expect.any(String) },
    });
    expect(await outbox(lead)).toHaveLength(1);
    expect(h.whatsappSendQueued).toHaveLength(1);
    const last = (await thread(rep, lead)).messages.at(-1);
    expect(last).toMatchObject({ direction: "out", status: "queued", sentBy: { id: rep.id } });
    // Nothing counts as sent until Meta takes it (Task 4).
    expect((await h.queryAll("SELECT last_message_at FROM leads WHERE id = $1", [lead]))[0]).toEqual({
      last_message_at: null,
    });
  });

  it("words: empty, or over WhatsApp's 4,096 characters, is refused and says why", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    expect((await send(rep, lead, { text: "   " })).json().error).toMatchObject({ code: "EMPTY" });
    expect((await send(rep, lead, {})).statusCode).toBe(400);
    const long = await send(rep, lead, { text: "a".repeat(4097) });
    expect(long.statusCode).toBe(400);
    expect(long.json().error.message).toBe("WhatsApp messages can be up to 4,096 characters.");
    expect((await send(rep, lead, { text: "a".repeat(4096) })).statusCode).toBe(202);
  });

  it("thirty a minute each: the next one waits, said in words; others aren't held up", async () => {
    h.clock.advance(61_000); // a fresh minute: earlier tests sent as this person too
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    for (let i = 0; i < 30; i++) expect((await send(rep, lead, { text: `m${i}` })).statusCode).toBe(202);
    const r = await send(rep, lead, { text: "one more" });
    expect(r.statusCode).toBe(429);
    expect(r.json().error.message).toBe("That's a lot of messages at once. Wait a minute and send again.");
    expect((await send(mate, lead, { text: "from the team" })).statusCode).toBe(202);
    h.clock.advance(61_000);
    await writes();
    expect((await send(rep, lead, { text: "a minute later" })).statusCode).toBe(202);
  });
});

describe("files", () => {
  it("a PDF is attached as a draft, then sent with its words as the caption", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    const a = await attach(rep, lead, PDF, "Price list.pdf");
    expect(a.statusCode).toBe(201);
    expect(a.json().media).toEqual({
      id: expect.any(String),
      kind: "document",
      mime: "application/pdf",
      filename: "Price list.pdf",
      size: PDF.length,
    });
    const [draft] = await h.queryAll<{ draft: boolean; uploaded_by: string; status: string }>(
      "SELECT draft, uploaded_by, status FROM whatsapp_media WHERE id = $1",
      [a.json().media.id],
    );
    expect(draft).toEqual({ draft: true, uploaded_by: rep.id, status: "ready" });
    const r = await send(rep, lead, { mediaId: a.json().media.id, text: "Our prices" });
    expect(r.statusCode).toBe(202);
    expect(r.json().message).toMatchObject({
      text: "Our prices",
      media: { id: a.json().media.id, kind: "document", filename: "Price list.pdf" },
    });
    expect(
      (
        await h.queryAll<{ draft: boolean }>("SELECT draft FROM whatsapp_media WHERE id = $1", [
          a.json().media.id,
        ])
      )[0],
    ).toEqual({ draft: false });
  });

  it("security: a file whose bytes aren't what it says is refused, whatever its name", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    for (const [bytes, name] of [
      [Buffer.from("<html><script>alert(1)</script>"), "brochure.pdf"],
      [Buffer.from("MZ\x90\0this is a program"), "photo.jpg"],
      [Buffer.from("<svg onload=alert(1)>"), "logo.png"],
    ] as const) {
      const r = await attach(rep, lead, bytes, name);
      expect([name, r.statusCode]).toEqual([name, 415]);
      expect(r.json().error.message).toBe(
        "LUME can send photos (JPEG, PNG), videos (MP4), voice notes and documents (PDF, Word, Excel, PowerPoint, text).",
      );
    }
  });

  it("over WhatsApp's size for its kind, refused with the limit in words", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(5 * 1024 * 1024)]);
    const r = await attach(rep, lead, jpeg, "big.jpg");
    expect(r.statusCode).toBe(413);
    expect(r.json().error.message).toBe("Photos can be up to 5 MB.");
  });

  it("a nearly full disk takes no new file, and says so", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    h.files.setDisk({ total: 100, free: 3 });
    try {
      const r = await attach(rep, lead, PDF, "a.pdf");
      expect(r.statusCode).toBe(507);
      expect(r.json().error.message).toBe("The server's disk is full. Ask an admin to free space.");
    } finally {
      h.files.setDisk({ total: 100 * 1024 ** 3, free: 60 * 1024 ** 3 });
    }
  });

  it("library: a file from the business's files is attached with nothing uploaded again, and goes as a document", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    const file = await libraryFile("Brochure.pdf");
    const a = await fromLibrary(rep, lead, file);
    expect(a.statusCode).toBe(201);
    expect(a.json().media).toEqual({
      id: expect.any(String),
      kind: "document",
      mime: "application/pdf",
      filename: "Brochure.pdf",
      size: PDF.length,
    });
    const [m] = await h.queryAll<{ draft: boolean; uploaded_by: string; sha256: string; lead_id: string }>(
      "SELECT draft, uploaded_by, sha256, lead_id FROM whatsapp_media WHERE id = $1",
      [a.json().media.id],
    );
    const [kept] = await h.queryAll<{ sha256: string }>("SELECT sha256 FROM message_files WHERE id = $1", [
      file,
    ]);
    expect(m).toEqual({ draft: true, uploaded_by: rep.id, sha256: kept!.sha256, lead_id: lead });
    const [refs] = await h.queryAll<{ refs: number }>("SELECT refs FROM whatsapp_files WHERE sha256 = $1", [
      kept!.sha256,
    ]);
    expect(refs).toEqual({ refs: 2 });
    meta.sent.length = 0;
    expect((await send(rep, lead, { mediaId: a.json().media.id, text: "Our brochure" })).statusCode).toBe(
      202,
    );
    await h.runWhatsAppSend();
    expect(meta.sent.map((s) => s.body.document)).toEqual([
      { id: expect.any(String), caption: "Our brochure", filename: "Brochure.pdf" },
    ]);
  });

  it("library: an archived or unknown file isn't there to attach", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    const file = await libraryFile("Old brochure.pdf");
    await (await as(admin)).inject({ method: "POST", url: `/api/v1/files/${file}/archive` });
    for (const id of [file, randomUUID()]) {
      const r = await fromLibrary(rep, lead, id);
      expect(r.statusCode).toBe(404);
      expect(r.json().error).toEqual({
        code: "FILE_NOT_FOUND",
        message: "That file isn't in your files any more.",
      });
    }
  });

  it("library: the same checks as any reply (the 24 hours, who may send, who may see the lead)", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const file = await libraryFile("Brochure.pdf");
    expect((await fromLibrary(rep, lead, file)).json().error.code).toBe("WINDOW_CLOSED");
    await writes();
    expect((await fromLibrary(viewer, lead, file)).statusCode).toBe(403);
    const other = await h.seedLead({ ownerId: admin.id, name: "Karan Mehta", phone: "+919876500011" });
    expect((await fromLibrary(rep, other, file)).statusCode).toBe(404);
    expect(
      await h.queryAll("SELECT 1 FROM whatsapp_media WHERE lead_id = ANY($1::uuid[])", [[lead, other]]),
    ).toEqual([]);
  });

  it("security: a file attached to one lead, or by someone else, can't be sent to another", async () => {
    const sneha = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const karan = await h.seedLead({ ownerId: rep.id, name: "Karan Mehta", phone: "+919876500011" });
    await writes();
    await writes({ from: "+919876500011" });
    const a = (await attach(rep, sneha, PDF, "a.pdf")).json().media.id as string;
    const r = await send(rep, karan, { mediaId: a });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toBe("That file isn't attached here any more. Attach it again.");
    expect((await send(mate, sneha, { mediaId: a })).statusCode).toBe(400);
  });

  it("a voice note goes without words: words with one are refused, and say to send them apart", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    const a = (await attach(rep, lead, Buffer.from("OggS\0\x02voice"), "note.ogg")).json().media.id as string;
    const r = await send(rep, lead, { mediaId: a, text: "listen" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toBe(
      "A voice note goes without words. Send the words as their own message.",
    );
    expect((await send(rep, lead, { mediaId: a })).statusCode).toBe(202);
  });

  it("a caption is up to WhatsApp's 1,024 characters", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    const a = (await attach(rep, lead, PDF, "a.pdf")).json().media.id as string;
    const r = await send(rep, lead, { mediaId: a, text: "a".repeat(1025) });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toBe("Words with a file can be up to 1,024 characters.");
  });
});
