import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { FAKE_PDF, FAKE_WEBP, tinyPdf } from "../../../test/render-fake";
import { sha256Of } from "../whatsapp/files";

/** Reading the business's files in LUME (plan 2026-10-20-media-tab, Task 5): the file, its thumbnail, its PDF. */
let h: Harness;
type U = { id: string; email: string; password: string };
let admin: U;
let rep: U;
let outsider: U;

const PDF = tinyPdf(["Brightpath Interiors", "Our prices"]);
const PPTX = Buffer.concat([
  Buffer.from("PK\x03\x04[Content_Types].xml ppt/slides/slide1.xml", "latin1"),
  Buffer.alloc(64),
]);
const MP4 = Buffer.concat([Buffer.from("\x00\x00\x00\x18ftypisom", "latin1"), Buffer.alloc(200, 7)]);

const as = (u: U) => h.signIn(u);
const upload = async (bytes: Buffer, name: string) =>
  (
    await (
      await as(admin)
    ).inject({
      method: "POST",
      url: "/api/v1/files",
      headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) },
      payload: bytes,
    })
  ).json().file as { id: string; thumbUrl: string | null };
const get = async (u: U, url: string, headers: Record<string, string> = {}) =>
  (await as(u)).inject({ method: "GET", url, headers });

beforeAll(async () => {
  h = await createHarness({ render: true });
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({
    grants: [
      { key: "leads.view", scope: "own" },
      { key: "templates.use", scope: null },
    ],
    totp: false,
  });
  outsider = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: false });
});
afterAll(() => h.close());
beforeEach(async () => {
  await h.ownerPool.query("DELETE FROM message_files");
  await h.ownerPool.query("DELETE FROM file_previews");
  h.previewQueued.splice(0);
});

describe("a file in LUME's viewer", () => {
  it("a rep who may use templates reads a file, its thumbnail and an Office file's PDF", async () => {
    const pdf = await upload(PDF, "Brochure.pdf");
    const deck = await upload(PPTX, "Our work.pptx");
    await h.runPreviews();

    const content = await get(rep, `/api/v1/files/${pdf.id}/content`);
    expect(content.statusCode).toBe(200);
    expect(content.rawPayload).toEqual(PDF);
    expect(content.headers["content-type"]).toBe("application/pdf");
    expect(content.headers["x-content-type-options"]).toBe("nosniff");
    expect(content.headers["content-security-policy"]).toContain("sandbox");
    expect(content.headers["cache-control"]).toBe("private, max-age=3600");

    const listed = (await (await as(rep)).inject({ method: "GET", url: "/api/v1/files" })).json().files;
    const thumbUrl = listed.find((f: { id: string }) => f.id === pdf.id).thumbUrl as string;
    const thumb = await get(rep, thumbUrl);
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers["content-type"]).toBe("image/webp");
    expect(thumb.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(thumb.rawPayload).toEqual(FAKE_WEBP);

    const pages = await get(rep, `/api/v1/files/${deck.id}/pdf`);
    expect(pages.statusCode).toBe(200);
    expect(pages.headers["content-type"]).toBe("application/pdf");
    expect(pages.rawPayload).toEqual(FAKE_PDF);
    // A PDF is its own pages; only Office files have one made.
    expect((await get(rep, `/api/v1/files/${pdf.id}/pdf`)).statusCode).toBe(404);
  });

  it("a byte range of a video is 206, so it plays and seeks without loading it all", async () => {
    const clip = await upload(MP4, "Site visit.mp4");
    const r = await get(rep, `/api/v1/files/${clip.id}/content`, { range: "bytes=0-9" });
    expect(r.statusCode).toBe(206);
    expect(r.headers["content-range"]).toBe(`bytes 0-9/${MP4.length}`);
    expect(r.rawPayload).toEqual(MP4.subarray(0, 10));
  });

  it("an archived file is 404 to a rep, and an admin still opens it", async () => {
    const pdf = await upload(PDF, "Brochure.pdf");
    await (await as(admin)).inject({ method: "POST", url: `/api/v1/files/${pdf.id}/archive` });
    expect((await get(rep, `/api/v1/files/${pdf.id}/content`)).statusCode).toBe(404);
    expect((await get(admin, `/api/v1/files/${pdf.id}/content`)).statusCode).toBe(200);
  });

  it("a thumbnail that isn't made yet is 404, as is a file that doesn't exist", async () => {
    const pdf = await upload(PDF, "Brochure.pdf");
    expect((await get(rep, `/api/v1/files/${pdf.id}/thumb`)).statusCode).toBe(404);
    expect((await get(rep, "/api/v1/files/0190e0c0-0000-7000-8000-00000000abcd/content")).statusCode).toBe(
      404,
    );
  });

  it("someone who can't use templates gets 403 for every one", async () => {
    const pdf = await upload(PDF, "Brochure.pdf");
    await h.runPreviews();
    for (const part of ["content", "thumb", "pdf"])
      expect((await get(outsider, `/api/v1/files/${pdf.id}/${part}`)).statusCode).toBe(403);
  });

  it("Try again puts a failed preview back in the queue, for an admin only", async () => {
    const pdf = await upload(PDF, "Brochure.pdf");
    h.previewQueued.splice(0);
    await h.ownerPool.query("UPDATE file_previews SET state = 'failed', tries = 3 WHERE sha256 = $1", [
      sha256Of(PDF),
    ]);
    const asRep = await (await as(rep)).inject({ method: "POST", url: `/api/v1/files/${pdf.id}/preview` });
    expect(asRep.statusCode).toBe(403);
    const r = await (await as(admin)).inject({ method: "POST", url: `/api/v1/files/${pdf.id}/preview` });
    expect(r.statusCode).toBe(202);
    expect(r.json().file).toMatchObject({ preview: "pending" });
    expect(h.previewQueued).toEqual([sha256Of(PDF)]);
    await h.runPreviews();
    const row = await h.ownerPool.query("SELECT state, tries FROM file_previews WHERE sha256 = $1", [
      sha256Of(PDF),
    ]);
    expect(row.rows[0]).toEqual({ state: "ready", tries: 1 });
  });
});
