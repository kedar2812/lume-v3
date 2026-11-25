import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";

/** Photos and files in Team Chat (plan 2026-11-24-team-chat-2a, Task 5). */
let h: Harness;
let admin: SeededUser;
let rep: SeededUser;
let outsider: SeededUser;
let ch: string;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const use = { key: "chat.use", scope: null } as const;

const as = async (u: SeededUser) => h.signIn(u);
const upload = async (u: SeededUser, bytes: Buffer, name: string) =>
  (await as(u)).inject({
    method: "POST",
    url: "/api/v1/chat/files",
    headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) },
    payload: bytes,
  });
const send = async (u: SeededUser, files: string[], body?: string) =>
  (await as(u)).inject({
    method: "POST",
    url: `/api/v1/chat/${ch}/messages`,
    payload: { clientId: crypto.randomUUID(), files, ...(body ? { body } : {}) },
  });
const open = async (u: SeededUser, id: string) =>
  (await as(u)).inject({ method: "GET", url: `/api/v1/chat/files/${id}` });
/** How many uses hold the bytes of this person's own file (read as them: row security is forced). */
const refsOf = async (u: SeededUser, id: string) => {
  const c = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true)", [u.id]);
    return (
      await c.query<{ refs: number }>(
        "SELECT w.refs FROM whatsapp_files w WHERE w.sha256 = (SELECT sha256 FROM chat_files WHERE id = $1)",
        [id],
      )
    ).rows[0]?.refs;
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
};

beforeAll(async () => {
  h = await createHarness();
  admin = await h.seedUser({
    name: "Maya Kapoor",
    grants: [use, { key: "chat.channels.manage", scope: null }],
  });
  rep = await h.seedUser({ name: "Rahul Mehta", grants: [use] });
  outsider = await h.seedUser({ name: "Arjun Nair", grants: [use] });
});
afterAll(async () => h.close());
beforeEach(async () => {
  await h.ownerPool.query("TRUNCATE chat_conversations CASCADE");
  ch = (
    await (
      await as(admin)
    ).inject({ method: "POST", url: "/api/v1/chat/channels", payload: { name: "sales", people: [rep.id] } })
  ).json().id;
});

describe("chat files", () => {
  it("a photo sent in a channel opens for its members and no one else; alone, it needs no words", async () => {
    const up = await upload(rep, PNG, "studio-before-after.png");
    expect(up.statusCode, up.body).toBe(201);
    const file = up.json().file;
    expect(file).toMatchObject({
      name: "studio-before-after.png",
      kind: "image",
      mime: "image/png",
      size: PNG.length,
    });
    // Before it's sent, only its sender may open it.
    expect((await open(rep, file.id)).statusCode).toBe(200);
    expect((await open(admin, file.id)).statusCode).toBe(404);
    const sent = await send(rep, [file.id]);
    expect(sent.statusCode, sent.body).toBe(201);
    expect(sent.json().files).toMatchObject([{ id: file.id, url: `/api/v1/chat/files/${file.id}` }]);
    expect((await open(admin, file.id)).statusCode).toBe(200);
    expect((await open(outsider, file.id)).statusCode).toBe(404);
  });

  it("a file is used by the person who uploaded it, once", async () => {
    const file = (await upload(rep, PNG, "a.png")).json().file;
    expect((await send(admin, [file.id], "Mine now")).statusCode).toBe(400);
    expect((await send(rep, [file.id])).statusCode).toBe(201);
    const again = await send(rep, [file.id], "Twice");
    expect(again.statusCode).toBe(400);
    expect(again.json().error.message).toBe("A file here was already sent, or isn't yours to send.");
  });

  it("a chat file holds its bytes, so Clean up never clears bytes a chat message uses", async () => {
    const file = (await upload(rep, PNG, "kept.png")).json().file;
    const held = await refsOf(rep, file.id);
    const again = (await upload(rep, PNG, "again.png")).json().file;
    expect(await refsOf(rep, again.id)).toBe(held! + 1);
    await send(rep, [file.id]);
    expect(await refsOf(rep, file.id)).toBe(held! + 1);
  });

  it("a deleted message's file no longer opens", async () => {
    const file = (await upload(rep, PNG, "gone.png")).json().file;
    const m = (await send(rep, [file.id])).json();
    await (await as(rep)).inject({ method: "DELETE", url: `/api/v1/chat/messages/${m.id}` });
    expect((await open(admin, file.id)).statusCode).toBe(404);
  });

  it("a file that isn't what its name says is refused", async () => {
    const r = await upload(rep, Buffer.from("not really a picture"), "photo.png");
    expect(r.statusCode).toBe(415);
  });
});
