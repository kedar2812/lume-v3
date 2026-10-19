import { existsSync } from "node:fs";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { LIMITS } from "./sniff";

/** The file library (plan W3b-1 Task 2): brochures and photos kept once, managed by templates.manage. */
let h: Harness;
type U = { id: string; email: string; password: string };
let admin: U;
let rep: U;
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const as = (u: U) => h.signIn(u);
const upload = async (u: U, bytes: Buffer, name: string) =>
  (await as(u)).inject({
    method: "POST",
    url: "/api/v1/files",
    headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) },
    payload: bytes,
  });
const call = async (u: U, method: "GET" | "PATCH" | "POST" | "PUT", url: string, payload?: object) =>
  (await as(u)).inject({ method, url, ...(payload ? { payload } : {}) });
const refsOf = async (sha: string) =>
  (await h.ownerPool.query<{ refs: number }>("SELECT refs FROM whatsapp_files WHERE sha256 = $1", [sha]))
    .rows[0]?.refs;
const shaOf = async (id: string) =>
  (await h.ownerPool.query<{ sha256: string }>("SELECT sha256 FROM message_files WHERE id = $1", [id]))
    .rows[0]!.sha256;

beforeAll(async () => {
  h = await createHarness();
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({
    grants: [
      { key: "leads.view", scope: "own" },
      { key: "messages.send", scope: "own" },
      { key: "templates.use", scope: null },
    ],
    totp: false,
  });
});
afterAll(() => h.close());
beforeEach(async () => {
  await h.ownerPool.query("DELETE FROM message_files");
  h.files.setDisk(null);
});

describe("the file library", () => {
  it("keeps an uploaded PDF and lists it, its kind read from its bytes", async () => {
    const r = await upload(admin, PDF, "Brochure.pdf");
    expect(r.statusCode).toBe(201);
    expect(r.json().file).toMatchObject({
      name: "Brochure.pdf",
      kind: "document",
      mime: "application/pdf",
      size: PDF.length,
      link: { on: false, url: null, opens: 0 },
      archived: false,
    });
    const list = await call(admin, "GET", "/api/v1/files");
    expect(list.json().files.map((f: { name: string }) => f.name)).toEqual(["Brochure.pdf"]);
  });

  it("the same bytes under a second name are a second file in the library and one file on disk", async () => {
    const a = (await upload(admin, PDF, "Brochure.pdf")).json().file;
    const b = (await upload(admin, PDF, "Brochure (Hindi).pdf")).json().file;
    const sha = await shaOf(a.id);
    expect(await shaOf(b.id)).toBe(sha);
    expect(await refsOf(sha)).toBe(2);
    expect(existsSync(h.files.store.path(sha))).toBe(true);
  });

  it("refuses an HTML page named .pdf, and a video over WhatsApp's size", async () => {
    const html = await upload(admin, Buffer.from("<html><script>alert(1)</script></html>"), "Brochure.pdf");
    expect(html.statusCode).toBe(415);
    expect(html.json().error.code).toBe("FILE_TYPE");
    const big = Buffer.alloc(LIMITS.video + 1);
    big.write("ftypisom", 4, "latin1");
    const video = await upload(admin, big, "Walkthrough.mp4");
    expect(video.statusCode).toBe(413);
    expect(video.json().error.message).toBe("Videos can be up to 16 MB.");
  });

  it("with the disk nearly full, says so and writes nothing", async () => {
    h.files.setDisk({ total: 100, free: 4 });
    const r = await upload(admin, PNG, "Office.png");
    expect(r.statusCode).toBe(507);
    expect(r.json().error.code).toBe("DISK_FULL");
    expect((await call(admin, "GET", "/api/v1/files")).json().files).toEqual([]);
  });

  it("two live files can't share a name, in any case", async () => {
    await upload(admin, PDF, "Price list.pdf");
    const r = await upload(admin, PNG, "price LIST.pdf");
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toEqual({
      code: "NAME_TAKEN",
      message: "A file called “price LIST.pdf” is already in your files.",
    });
  });

  it("renames, archives and restores; archiving keeps the stored file for messages that sent it", async () => {
    const f = (await upload(admin, PDF, "Brochure.pdf")).json().file;
    const sha = await shaOf(f.id);
    expect(
      (await call(admin, "PATCH", `/api/v1/files/${f.id}`, { name: "Brochure 2026.pdf" })).json().file.name,
    ).toBe("Brochure 2026.pdf");
    expect((await call(admin, "POST", `/api/v1/files/${f.id}/archive`)).statusCode).toBe(200);
    expect(await refsOf(sha)).toBe(1);
    expect((await call(admin, "GET", "/api/v1/files")).json().files).toEqual([]);
    const archived = (await call(admin, "GET", "/api/v1/files?archived=1")).json().files;
    expect(archived.map((x: { archived: boolean }) => x.archived)).toEqual([true]);
    expect((await call(admin, "POST", `/api/v1/files/${f.id}/restore`)).json().file.archived).toBe(false);
  });

  it("a rep who may use templates lists the files, and changes nothing", async () => {
    const f = (await upload(admin, PDF, "Brochure.pdf")).json().file;
    expect((await call(rep, "GET", "/api/v1/files")).json().files).toHaveLength(1);
    expect((await upload(rep, PNG, "Mine.png")).statusCode).toBe(403);
    expect((await call(rep, "PATCH", `/api/v1/files/${f.id}`, { name: "x.pdf" })).statusCode).toBe(403);
    expect((await call(rep, "POST", `/api/v1/files/${f.id}/archive`)).statusCode).toBe(403);
    expect((await call(rep, "PUT", `/api/v1/files/${f.id}/link`, { on: true })).statusCode).toBe(403);
    expect((await call(rep, "GET", "/api/v1/files?archived=1")).statusCode).toBe(403);
  });

  it("a link: on gives an unguessable address, off takes it away, on again gives the same one", async () => {
    const f = (await upload(admin, PDF, "Brochure.pdf")).json().file;
    const on = (await call(admin, "PUT", `/api/v1/files/${f.id}/link`, { on: true })).json().file.link;
    expect(on.on).toBe(true);
    expect(on.url).toMatch(/\/f\/[A-Za-z0-9_-]{43}$/);
    const off = (await call(admin, "PUT", `/api/v1/files/${f.id}/link`, { on: false })).json().file.link;
    expect(off).toEqual({ on: false, url: null, opens: 0 });
    const again = (await call(admin, "PUT", `/api/v1/files/${f.id}/link`, { on: true })).json().file.link;
    expect(again.url).toBe(on.url);
    const audit = await h.ownerPool.query<{ action: string }>(
      "SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id",
      [f.id],
    );
    expect(audit.rows.map((x) => x.action)).toEqual([
      "file.uploaded",
      "file.link_on",
      "file.link_off",
      "file.link_on",
    ]);
  });
});
