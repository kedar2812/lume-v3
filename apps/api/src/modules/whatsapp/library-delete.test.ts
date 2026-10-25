import { randomUUID } from "node:crypto";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";

/**
 * Deleting a file for good (owner, 2026-10-25: "permanent delete in the Media tab, with confirmation"). The library's
 * row goes; messages that already sent the file keep it; what still needs the file says so.
 */
let h: Harness;
type U = { id: string; email: string; password: string };
let admin: U;
let rep: U;
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const as = (u: U) => h.signIn(u);
const upload = async (bytes: Buffer, name: string) => {
  const r = await (
    await as(admin)
  ).inject({
    method: "POST",
    url: "/api/v1/files",
    headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) },
    payload: bytes,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().file as { id: string; name: string };
};
const del = async (u: U, id: string) =>
  (await as(u)).inject({ method: "DELETE", url: `/api/v1/files/${id}` });
const names = async () =>
  (await (await as(admin)).inject({ method: "GET", url: "/api/v1/files" }))
    .json()
    .files.map((f: { name: string }) => f.name);
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
  await h.ownerPool.query("DELETE FROM whatsapp_template_submissions");
  await h.ownerPool.query("DELETE FROM ai_profile");
  await h.ownerPool.query("DELETE FROM message_files");
});

describe("deleting a file for good", () => {
  it("leaves Media and its link; the bytes stay while anything else holds them", async () => {
    const a = await upload(PDF, "Brochure.pdf");
    const b = await upload(PDF, "Brochure (Hindi).pdf");
    const sha = await shaOf(a.id);
    expect(await refsOf(sha)).toBeGreaterThanOrEqual(2);
    const before = (await refsOf(sha))!;
    const r = await del(admin, a.id);
    expect(r.statusCode, r.body).toBe(204);
    expect(await names()).toEqual(["Brochure (Hindi).pdf"]);
    // One holder fewer; the other file still has the bytes.
    expect(await refsOf(sha)).toBe(before - 1);
    expect((await shaOf(b.id)) === sha).toBe(true);
    const audit = await h.ownerPool.query(
      "SELECT 1 FROM audit_log WHERE action = 'file.deleted' AND entity_id = $1",
      [a.id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it("the last file with those bytes: nothing holds them any more, so the hourly sweep frees the space", async () => {
    const a = await upload(PNG, "Office.png");
    const sha = await shaOf(a.id);
    expect((await del(admin, a.id)).statusCode).toBe(204);
    expect(await refsOf(sha)).toBe(0);
  });

  it("an archived file can be deleted too", async () => {
    const a = await upload(PNG, "Office.png");
    await (await as(admin)).inject({ method: "POST", url: `/api/v1/files/${a.id}/archive` });
    expect((await del(admin, a.id)).statusCode).toBe(204);
    const archived = await (await as(admin)).inject({ method: "GET", url: "/api/v1/files?archived=1" });
    expect(archived.json().files).toEqual([]);
  });

  it("a file a WhatsApp template shows at its top stays: archive it instead", async () => {
    const f = await upload(PNG, "Kitchen.png");
    const t = await (
      await as(admin)
    ).inject({
      method: "POST",
      url: "/api/v1/templates",
      payload: { name: "Visit", category: "first_touch", body: "Hi {{first_name}}, here's our work." },
    });
    const version = (
      await h.ownerPool.query<{ current_version_id: string }>(
        "SELECT current_version_id FROM message_templates WHERE id = $1",
        [t.json().id],
      )
    ).rows[0]!.current_version_id;
    await h.ownerPool.query(
      `INSERT INTO whatsapp_template_submissions
         (id, template_version_id, waba_id, language, category, meta_name, header_file_id, status)
       VALUES ($1, $2, 'waba-1', 'en', 'MARKETING', 'visit_1', $3, 'approved')`,
      [randomUUID(), version, f.id],
    );
    const r = await del(admin, f.id);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toEqual({
      code: "FILE_IN_TEMPLATE",
      message: "A WhatsApp template shows this file at its top. Archive it instead.",
    });
    expect(await names()).toEqual(["Kitchen.png"]);
  });

  it("a file LUME AI may send leaves its list too", async () => {
    const keep = await upload(PDF, "Rates.pdf");
    const f = await upload(PNG, "Kitchen.png");
    const set = await (
      await as(admin)
    ).inject({ method: "PATCH", url: "/api/v1/ai/profile", payload: { knows: { files: [keep.id, f.id] } } });
    expect(set.statusCode, set.body).toBe(200);
    expect((await del(admin, f.id)).statusCode).toBe(204);
    const p = (await (await as(admin)).inject({ method: "GET", url: "/api/v1/ai/profile" })).json();
    expect(p.files.map((x: { id: string }) => x.id)).toEqual([keep.id]);
    // And from what's kept, not only from what's shown.
    const kept = await h.ownerPool.query<{ files: string[] }>(
      "SELECT profile -> 'knows' -> 'files' AS files FROM ai_profile WHERE id = 1",
    );
    expect(kept.rows[0]!.files).toEqual([keep.id]);
  });

  it("only someone who manages templates may; a file already gone says so", async () => {
    const f = await upload(PDF, "Brochure.pdf");
    expect((await del(rep, f.id)).statusCode).toBe(403);
    expect(await names()).toEqual(["Brochure.pdf"]);
    expect((await del(admin, f.id)).statusCode).toBe(204);
    const again = await del(admin, f.id);
    expect(again.statusCode).toBe(404);
  });
});
