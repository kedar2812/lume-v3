import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { FAKE_WEBP } from "../../../test/render-fake";
import { sha256Of } from "../whatsapp/files";

/**
 * Photos in Team Chat as thumbnails (plan 2026-11-25-team-chat-2b, Task 7; pending list 2026-11-28): a photo's preview
 * is made after it's sent, as the library's are; the bubble asks for it, and gets the photo itself until it's made.
 */
let h: Harness;
let bare: Harness;
let admin: SeededUser;
let outsider: SeededUser;
let ch: string;
// A real (1x1) PNG: the file check reads its bytes.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const use = { key: "chat.use", scope: null } as const;

async function channel(hh: Harness, u: SeededUser) {
  const r = await (
    await hh.signIn(u)
  ).inject({
    method: "POST",
    url: "/api/v1/chat/channels",
    payload: { name: `photos-${Math.random().toString(36).slice(2, 8)}`, people: [] },
  });
  expect(r.statusCode, r.body).toBeLessThan(300);
  return r.json().id as string;
}
const upload = async (hh: Harness, u: SeededUser, bytes: Buffer) =>
  (await hh.signIn(u)).inject({
    method: "POST",
    url: "/api/v1/chat/files",
    headers: { "content-type": "application/octet-stream", "x-file-name": "photo.png" },
    payload: bytes,
  });
const sendWith = async (hh: Harness, u: SeededUser, conv: string, files: string[]) =>
  (await hh.signIn(u)).inject({
    method: "POST",
    url: `/api/v1/chat/${conv}/messages`,
    payload: { clientId: crypto.randomUUID(), files },
  });
const thumb = async (hh: Harness, u: SeededUser, id: string) =>
  (await hh.signIn(u)).inject({ method: "GET", url: `/api/v1/chat/files/${id}/thumb` });

beforeAll(async () => {
  h = await createHarness({ render: true });
  bare = await createHarness();
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  outsider = await h.seedUser({ grants: [use], totp: true });
  ch = await channel(h, admin);
});
afterAll(async () => {
  await h.close();
  await bare.close();
});
beforeEach(() => {
  h.previewQueued.splice(0);
});

describe("Team Chat photos as thumbnails", () => {
  it("a photo's preview is queued when it's uploaded, and made like the library's", async () => {
    const r = await upload(h, admin, PNG);
    expect(r.statusCode, r.body).toBe(201);
    expect(h.previewQueued).toEqual([sha256Of(PNG)]);
  });

  it("before it's made: the photo itself; once made: the small one", async () => {
    const f = (await upload(h, admin, PNG)).json().file;
    expect((await sendWith(h, admin, ch, [f.id])).statusCode).toBeLessThan(300);
    const before = await thumb(h, admin, f.id);
    expect(before.statusCode).toBe(200);
    expect(before.rawPayload).toEqual(PNG);
    await h.runPreviews();
    const after = await thumb(h, admin, f.id);
    expect(after.statusCode).toBe(200);
    expect(after.headers["content-type"]).toContain("image/webp");
    expect(after.rawPayload).toEqual(FAKE_WEBP);
    // Made from the photo as it was sent: its own type, though the library never held it.
    expect(h.render!.calls).toContainEqual(expect.objectContaining({ path: "/v1/thumb", type: "image/png" }));
  });

  // Review 2026-11-28: shown in chat, a thumbnail is in use (Clean up must not count it idle); let go, it's made anew.
  it("a thumbnail Clean up let go: the photo meanwhile, and it's asked to be made again", async () => {
    const f = (await upload(h, admin, PNG)).json().file;
    await sendWith(h, admin, ch, [f.id]);
    await h.runPreviews();
    await h.ownerPool.query("UPDATE file_previews SET state = 'cleared' WHERE sha256 = $1", [sha256Of(PNG)]);
    h.previewQueued.splice(0);
    expect((await thumb(h, admin, f.id)).rawPayload).toEqual(PNG);
    expect(h.previewQueued).toEqual([sha256Of(PNG)]);
    await h.runPreviews();
    expect((await thumb(h, admin, f.id)).rawPayload).toEqual(FAKE_WEBP);
  });

  it("shown in chat, a thumbnail counts as opened (at most once a day), so Clean up never takes it for idle", async () => {
    const f = (await upload(h, admin, PNG)).json().file;
    await sendWith(h, admin, ch, [f.id]);
    await h.runPreviews();
    await h.ownerPool.query(
      "UPDATE file_previews SET opened_at = now() - interval '100 days' WHERE sha256 = $1",
      [sha256Of(PNG)],
    );
    await thumb(h, admin, f.id);
    const { rows } = await h.ownerPool.query<{ fresh: boolean }>(
      "SELECT opened_at > now() - interval '1 hour' AS fresh FROM file_previews WHERE sha256 = $1",
      [sha256Of(PNG)],
    );
    expect(rows[0]!.fresh).toBe(true);
  });

  it("a thumbnail whose file is gone from the store: the photo, never a broken image", async () => {
    const f = (await upload(h, admin, PNG)).json().file;
    await sendWith(h, admin, ch, [f.id]);
    await h.runPreviews();
    const { rmSync } = await import("node:fs");
    // A thumbnail that points at bytes no longer kept (as a store tidied by hand).
    await h.ownerPool.query("UPDATE file_previews SET thumb_sha256 = $2 WHERE sha256 = $1", [
      sha256Of(PNG),
      sha256Of(FAKE_WEBP),
    ]);
    rmSync(h.files.store.path(sha256Of(FAKE_WEBP)), { force: true });
    const r = await thumb(h, admin, f.id);
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload).toEqual(PNG);
  });

  it("someone who can't read the message gets nothing of it, the thumbnail included", async () => {
    const f = (await upload(h, admin, PNG)).json().file;
    await sendWith(h, admin, ch, [f.id]);
    await h.runPreviews();
    expect((await thumb(h, outsider, f.id)).statusCode).toBe(404);
  });

  it("a document never asks for a preview here (a thumbnail is a photo's)", async () => {
    const pdf = Buffer.from("%PDF-1.4\n%\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
    await (
      await h.signIn(admin)
    ).inject({
      method: "POST",
      url: "/api/v1/chat/files",
      headers: { "content-type": "application/octet-stream", "x-file-name": "a.pdf" },
      payload: pdf,
    });
    expect(h.previewQueued).toEqual([]);
  });

  it("without a render service: no preview is asked for, and the photo is served as it is", async () => {
    const boss = await bare.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
    const conv = await channel(bare, boss);
    const f = (await upload(bare, boss, PNG)).json().file;
    await sendWith(bare, boss, conv, [f.id]);
    expect(bare.previewQueued).toEqual([]);
    expect((await thumb(bare, boss, f.id)).rawPayload).toEqual(PNG);
  });
});
