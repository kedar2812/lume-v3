import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { LINK_OPENS_PER_MINUTE } from "./link";

/** A library file's share link (plan W3b-1 Task 3): served while it's on, the same 404 whenever it isn't. */
let h: Harness;
type U = { id: string; email: string; password: string };
let admin: U;
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\nendobj\n");

const as = (u: U) => h.signIn(u);
async function sharedFile(name = "Brochure.pdf") {
  const c = await as(admin);
  const file = (
    await c.inject({
      method: "POST",
      url: "/api/v1/files",
      headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) },
      payload: PDF,
    })
  ).json().file;
  const link = (
    await c.inject({ method: "PUT", url: `/api/v1/files/${file.id}/link`, payload: { on: true } })
  ).json().file.link;
  return { id: file.id as string, path: new URL(link.url).pathname };
}
// Nobody signed in: the link is for anyone who has it. Each test from its own address, for the per-address limit.
let ip = 1;
const open = (path: string, headers: Record<string, string> = {}, method: "GET" | "HEAD" = "GET") =>
  h.app.inject({ method, url: path, headers, remoteAddress: `198.51.100.${ip}` });

beforeAll(async () => {
  h = await createHarness();
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
});
afterAll(() => h.close());
beforeEach(async () => {
  await h.ownerPool.query("DELETE FROM message_files");
  ip += 1;
});

describe("a file's link", () => {
  it("serves the file to anyone with the link, sandboxed and never sniffed", async () => {
    const f = await sharedFile();
    const r = await open(f.path);
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.equals(PDF)).toBe(true);
    expect(r.headers["content-type"]).toBe("application/pdf");
    expect(r.headers["content-disposition"]).toContain("filename*=UTF-8''Brochure.pdf");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(r.headers["content-security-policy"])).toContain("sandbox");
    expect(r.headers["cache-control"]).toBe("private, max-age=300");
  });

  it("switched off or archived, it answers exactly as a link that never existed", async () => {
    const f = await sharedFile();
    const never = await open(`/f/${"A".repeat(43)}`);
    expect(never.statusCode).toBe(404);
    await (
      await as(admin)
    ).inject({ method: "PUT", url: `/api/v1/files/${f.id}/link`, payload: { on: false } });
    const off = await open(f.path);
    expect(off.statusCode).toBe(404);
    expect(off.body).toBe(never.body);
    await (
      await as(admin)
    ).inject({ method: "PUT", url: `/api/v1/files/${f.id}/link`, payload: { on: true } });
    await (await as(admin)).inject({ method: "POST", url: `/api/v1/files/${f.id}/archive` });
    const archived = await open(f.path);
    expect(archived.statusCode).toBe(404);
    expect(archived.body).toBe(never.body);
  });

  it("a token that can't be one (wrong length or characters) is the same 404", async () => {
    for (const bad of [
      "/f/short",
      `/f/${"A".repeat(42)}!`,
      `/f/${"A".repeat(44)}`,
      "/f/..%2F..%2Fetc%2Fpasswd",
    ])
      expect((await open(bad)).statusCode).toBe(404);
  });

  it("serves a byte range, as a phone's PDF viewer asks", async () => {
    const f = await sharedFile();
    const r = await open(f.path, { range: "bytes=0-1" });
    expect(r.statusCode).toBe(206);
    expect(r.headers["content-range"]).toBe(`bytes 0-1/${PDF.length}`);
    expect(r.body).toBe("%P");
  });

  it("counts each full open, not a range or a HEAD", async () => {
    const f = await sharedFile();
    for (let i = 0; i < 3; i++) await open(f.path);
    await open(f.path, { range: "bytes=0-1" });
    await open(f.path, {}, "HEAD");
    const list = (await (await as(admin)).inject({ method: "GET", url: "/api/v1/files" })).json().files;
    expect(list[0].link.opens).toBe(3);
  });

  it(`slows one address after ${LINK_OPENS_PER_MINUTE} opens in a minute`, async () => {
    const f = await sharedFile();
    for (let i = 0; i < LINK_OPENS_PER_MINUTE; i++) expect((await open(f.path)).statusCode).toBe(200);
    const r = await open(f.path);
    expect(r.statusCode).toBe(429);
    expect(r.headers["retry-after"]).toBeDefined();
  });
});
