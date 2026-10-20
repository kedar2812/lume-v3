import { existsSync, readFileSync } from "node:fs";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { FAKE_PDF, FAKE_WEBP, tinyPdf } from "../../../test/render-fake";
import { sha256Of } from "../whatsapp/files";
import { sweepPreviews, viewAsOf } from "./preview";

/** Media's previews (plan 2026-10-20-media-tab, Task 4): made once per file's bytes by the render service. */
let h: Harness;
let bare: Harness;
type U = { id: string; email: string; password: string };
let admin: U;
let bareAdmin: U;

const PDF = tinyPdf(["Brightpath Interiors", "Our prices", "Our work"]);
const ooxml = (part: string) =>
  Buffer.concat([
    Buffer.from(`PK\x03\x04[Content_Types].xml ${part}slides/slide1.xml`, "latin1"),
    Buffer.alloc(64),
  ]);
const PPTX = ooxml("ppt/");
const XLSX = ooxml("xl/");
const MP3 = Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.alloc(64, 1)]);
const TXT = Buffer.from("Kitchen sizes\n10 ft by 12 ft\n");

const upload = async (hh: Harness, u: U, bytes: Buffer, name: string) =>
  (await hh.signIn(u)).inject({
    method: "POST",
    url: "/api/v1/files",
    headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) },
    payload: bytes,
  });
const list = async (hh: Harness, u: U) =>
  (await (await hh.signIn(u)).inject({ method: "GET", url: "/api/v1/files" })).json().files as Record<
    string,
    unknown
  >[];
const previewRow = async (hh: Harness, sha: string) =>
  (
    await hh.ownerPool.query<{
      state: string;
      tries: number;
      thumb_sha256: string | null;
      pdf_sha256: string | null;
      pages: number | null;
    }>("SELECT state, tries, thumb_sha256, pdf_sha256, pages FROM file_previews WHERE sha256 = $1", [sha])
  ).rows[0];

beforeAll(async () => {
  h = await createHarness({ render: true });
  bare = await createHarness();
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  bareAdmin = await bare.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
});
afterAll(async () => {
  await h.close();
  await bare.close();
});
beforeEach(async () => {
  await h.ownerPool.query("DELETE FROM message_files");
  await h.ownerPool.query("DELETE FROM file_previews");
  h.previewQueued.splice(0);
  Object.assign(h.render!, { calls: [], fail: 0, down: false, thumbBody: null });
});

describe("how each kind of file is viewed", () => {
  it.each([
    ["image", "image/jpeg", "image"],
    ["video", "video/mp4", "video"],
    ["audio", "audio/ogg", "audio"],
    ["document", "application/pdf", "pdf"],
    ["document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "office"],
    ["document", "application/msword", "office"],
    ["document", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "office"],
    ["document", "application/vnd.ms-powerpoint", "office"],
    ["document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "sheet"],
    ["document", "application/vnd.ms-excel", "sheet"],
    ["document", "text/plain", "text"],
  ] as const)("%s %s is viewed as %s", (kind, mime, viewAs) => {
    expect(viewAsOf(kind, mime)).toBe(viewAs);
  });
});

describe("previews", () => {
  it("an uploaded PDF gets its first page as a thumbnail, and its page count", async () => {
    const r = await upload(h, admin, PDF, "Brochure.pdf");
    expect(r.statusCode).toBe(201);
    expect(r.json().file).toMatchObject({ viewAs: "pdf", preview: "pending", thumbUrl: null });
    expect(h.previewQueued).toEqual([sha256Of(PDF)]);
    await h.runPreviews();
    expect(h.render!.calls).toEqual([{ path: "/v1/thumb", type: "application/pdf", size: PDF.length }]);
    const [file] = await list(h, admin);
    const thumbSha = sha256Of(FAKE_WEBP);
    expect(file).toMatchObject({
      preview: "ready",
      pages: 2,
      width: 612,
      height: 792,
      thumbUrl: `/api/v1/files/${String(file!.id)}/thumb?v=${thumbSha.slice(0, 12)}`,
    });
    expect(readFileSync(h.files.store.path(thumbSha))).toEqual(FAKE_WEBP);
  });

  it("an uploaded .pptx gets a thumbnail and a PDF to page through", async () => {
    await upload(h, admin, PPTX, "Our work.pptx");
    await h.runPreviews();
    expect(h.render!.calls.map((c) => [c.path, c.type])).toEqual([
      ["/v1/pdf", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      ["/v1/thumb", "application/pdf"],
    ]);
    const [file] = await list(h, admin);
    expect(file).toMatchObject({ viewAs: "office", preview: "ready", pages: 2 });
    const row = await previewRow(h, sha256Of(PPTX));
    expect(row!.pdf_sha256).toBe(sha256Of(FAKE_PDF));
    expect(existsSync(h.files.store.path(sha256Of(FAKE_PDF)))).toBe(true);
  });

  it("a spreadsheet gets a thumbnail and no PDF: it's viewed as a sheet", async () => {
    await upload(h, admin, XLSX, "Prices.xlsx");
    await h.runPreviews();
    const [file] = await list(h, admin);
    expect(file).toMatchObject({ viewAs: "sheet", preview: "ready" });
    expect((await previewRow(h, sha256Of(XLSX)))!.pdf_sha256).toBeNull();
  });

  it("a text file gets its first page as a thumbnail, and no PDF", async () => {
    await upload(h, admin, TXT, "Sizes.txt");
    await h.runPreviews();
    expect(h.render!.calls.map((c) => [c.path, c.type])).toEqual([
      ["/v1/pdf", "text/plain"],
      ["/v1/thumb", "application/pdf"],
    ]);
    expect((await list(h, admin))[0]).toMatchObject({ viewAs: "text", preview: "ready" });
    expect((await previewRow(h, sha256Of(TXT)))!.pdf_sha256).toBeNull();
  });

  it("same bytes under two names: rendered once, both shown with it", async () => {
    await upload(h, admin, PDF, "Brochure.pdf");
    await upload(h, admin, PDF, "Brochure (copy).pdf");
    await h.runPreviews();
    expect(h.render!.calls).toHaveLength(1);
    const files = await list(h, admin);
    expect(files.map((f) => f.preview)).toEqual(["ready", "ready"]);
    expect(files[0]!.pages).toBe(files[1]!.pages);
  });

  it("a voice note has nothing to show: no preview, at once, and nothing sent to render", async () => {
    const r = await upload(h, admin, MP3, "Welcome.mp3");
    expect(r.json().file).toMatchObject({ viewAs: "audio", preview: "none" });
    expect(h.previewQueued).toEqual([]);
  });

  it("render down: the file is there at once, its preview waiting, then failed after 3 tries", async () => {
    h.render!.down = true;
    const r = await upload(h, admin, PDF, "Brochure.pdf");
    expect(r.statusCode).toBe(201);
    expect(r.json().file.preview).toBe("pending");
    await h.runPreviews();
    expect(await previewRow(h, sha256Of(PDF))).toMatchObject({ state: "pending", tries: 1 });
    expect(h.previewQueued).toEqual([sha256Of(PDF)]); // the queue tries again later
    await h.runPreviews();
    await h.runPreviews();
    expect(await previewRow(h, sha256Of(PDF))).toMatchObject({ state: "failed", tries: 3 });
    expect(h.previewQueued).toEqual([]);
    expect((await list(h, admin))[0]).toMatchObject({ preview: "failed", thumbUrl: null });
  });

  it("render back after a failure: it tries again, and the preview is made", async () => {
    h.render!.fail = 1;
    await upload(h, admin, PDF, "Brochure.pdf");
    await h.runPreviews();
    await h.runPreviews();
    expect(await previewRow(h, sha256Of(PDF))).toMatchObject({ state: "ready", tries: 2 });
  });

  it("an answer from render that isn't a WebP is refused, and the preview fails without trying again", async () => {
    h.render!.thumbBody = Buffer.from("<html><script>alert(1)</script></html>");
    await upload(h, admin, PDF, "Brochure.pdf");
    await h.runPreviews();
    expect(await previewRow(h, sha256Of(PDF))).toMatchObject({ state: "failed", thumb_sha256: null });
    expect(h.previewQueued).toEqual([]);
  });

  it("no render service on this server: no preview, at once, and the file is kept", async () => {
    const r = await upload(bare, bareAdmin, PDF, "Brochure.pdf");
    expect(r.statusCode).toBe(201);
    expect(r.json().file).toMatchObject({ viewAs: "pdf", preview: "none", thumbUrl: null });
    expect(bare.previewQueued).toEqual([]);
  });
});

describe("the sweep", () => {
  it("files in the library from before Media get their previews", async () => {
    const sha = (await h.files.store.put(PDF)).sha256;
    await h.ownerPool.query(
      "INSERT INTO whatsapp_files (sha256, size) VALUES ($1, $2) ON CONFLICT (sha256) DO NOTHING",
      [sha, PDF.length],
    );
    await h.ownerPool.query(
      `INSERT INTO message_files (id, sha256, name, mime, kind, size)
       VALUES ('00000000-0000-7000-8000-0000000000e1', $1, 'Old brochure.pdf', 'application/pdf', 'document', $2)`,
      [sha, PDF.length],
    );
    expect(await sweepPreviews(h.deps)).toEqual([sha]);
    expect(await previewRow(h, sha)).toMatchObject({ state: "pending" });
  });

  it("a preview left waiting over 10 minutes is queued again; a recent one isn't", async () => {
    await upload(h, admin, PDF, "Brochure.pdf");
    expect(await sweepPreviews(h.deps)).toEqual([]);
    h.clock.advance(11 * 60_000);
    expect(await sweepPreviews(h.deps)).toEqual([sha256Of(PDF)]);
  });
});
