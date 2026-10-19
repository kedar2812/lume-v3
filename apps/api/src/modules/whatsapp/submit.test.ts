import { ALL_GRANTS } from "@lume/core";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { sweepTemplates } from "./submit";

/** A template sent to WhatsApp for approval, and WhatsApp's answer (plan W3b-2 Task 4; spec 2026-10-18 §4.3). */
let h: Harness;
let meta: MetaFake;
type U = { id: string; email: string; password: string };
let admin: U;
let rep: U;
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\nendobj\n");

const as = (u: U) => h.signIn(u);
async function templateWith(body: string, category = "first_touch") {
  const r = await (
    await as(admin)
  ).inject({
    method: "POST",
    url: "/api/v1/templates",
    payload: { name: `Visit ${Math.random().toString(36).slice(2, 8)}`, category, body },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: string; name: string };
}
const submit = async (id: string, extra: Record<string, unknown> = {}) =>
  (await as(admin)).inject({
    method: "POST",
    url: `/api/v1/templates/${id}/whatsapp`,
    payload: { language: "en", ...extra },
  });
const view = async (u: U, id: string) =>
  (await (await as(u)).inject({ method: "GET", url: `/api/v1/templates/${id}/whatsapp` })).json();
const metaNameOfRow = async (templateId: string) =>
  (
    await h.ownerPool.query<{ meta_name: string }>(
      `SELECT s.meta_name FROM whatsapp_template_submissions s
       JOIN template_versions v ON v.id = s.template_version_id WHERE v.template_id = $1`,
      [templateId],
    )
  ).rows[0]!.meta_name;

// Notifications are each person's own: read with the backup role, as other tests do.
async function decided(userId: string) {
  const c = new pg.Client({ connectionString: h.url("lume_readonly_backup") });
  await c.connect();
  try {
    return (
      await c.query<{ title: string; kind: string }>(
        "SELECT title, kind FROM notifications WHERE user_id = $1 AND kind = 'template_decided' ORDER BY id",
        [userId],
      )
    ).rows;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  meta = await startMetaFake();
  h = await createHarness({
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: meta.url, version: meta.version, appId: meta.appId },
  });
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({ grants: [{ key: "templates.use", scope: null }], totp: false });
});
afterAll(async () => {
  await h.close();
  await meta.close();
});
beforeEach(async () => {
  await h.queryAll("DELETE FROM whatsapp_outbox"); // row-level secured: deleted with every lead in scope
  await h.ownerPool.query("DELETE FROM whatsapp_template_submissions");
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  meta.templates.clear();
  await seedNumber(h, { runAs: admin.id });
});

describe("submitting a template to WhatsApp", () => {
  it("LUME's variables go as numbered ones with samples, a library file at the top by its handle, and it waits for review", async () => {
    const t = await templateWith(
      "Hi {{lead.first_name}}, here is our brochure from {{business.name}}. Have a look!",
    );
    const file = (
      await (
        await as(admin)
      ).inject({
        method: "POST",
        url: "/api/v1/files",
        headers: { "content-type": "application/octet-stream", "x-file-name": "Brochure.pdf" },
        payload: PDF,
      })
    ).json().file;
    const r = await submit(t.id, { headerFileId: file.id });
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json().submissions).toEqual([
      expect.objectContaining({
        current: true,
        account: "+91 90000 00001",
        language: "en",
        category: "MARKETING",
        status: "pending",
        reason: null,
      }),
    ]);
    const sent = meta.calls
      .filter((c) => c.path.endsWith("/message_templates") && c.method === "POST")
      .at(-1)!.body as { components: Record<string, unknown>[] };
    expect(sent.components).toEqual([
      { type: "HEADER", format: "DOCUMENT", example: { header_handle: [expect.stringMatching(/^4::/)] } },
      {
        type: "BODY",
        text: "Hi {{1}}, here is our brochure from {{2}}. Have a look!",
        example: { body_text: [["Aisha", "Acme Studio"]] },
      },
    ]);
    const [row] = (
      await h.ownerPool.query<{ tokens: string[]; meta_template_id: string }>(
        "SELECT tokens, meta_template_id FROM whatsapp_template_submissions",
      )
    ).rows;
    expect(row).toEqual({
      tokens: ["lead.first_name", "business.name"],
      meta_template_id: expect.any(String),
    });
  });

  it("what WhatsApp would turn down is said first, in LUME's words, and nothing goes", async () => {
    const t = await templateWith("Your visit is confirmed for today, {{lead.first_name}}");
    const r = await submit(t.id);
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toEqual({
      code: "TEMPLATE_PROBLEMS",
      message: "WhatsApp would turn this template down.",
      details: ["WhatsApp doesn't take a template that ends with a variable. Add words before and after it."],
    });
    expect(meta.templates.size).toBe(0);
  });

  it("the same version twice is already with WhatsApp", async () => {
    const t = await templateWith("Hello there, see you at the studio soon.");
    expect((await submit(t.id)).statusCode).toBe(202);
    const again = await submit(t.id);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toBe("Already with WhatsApp for review.");
  });

  it("no connected number: nowhere to submit it, said so", async () => {
    await h.ownerPool.query("DELETE FROM whatsapp_numbers");
    const t = await templateWith("Hello there, see you at the studio soon.");
    const r = await submit(t.id);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toBe("Connect a WhatsApp number first, in Settings, under Integrations.");
  });

  it("a rep may read where it stands, not submit", async () => {
    const t = await templateWith("Hello there, see you at the studio soon.");
    await submit(t.id);
    expect((await view(rep, t.id)).submissions).toHaveLength(1);
    const r = await (
      await as(rep)
    ).inject({ method: "POST", url: `/api/v1/templates/${t.id}/whatsapp`, payload: { language: "en" } });
    expect(r.statusCode).toBe(403);
  });
});

describe("WhatsApp's answer", () => {
  it("approved by webhook: the template is ready, and whoever submitted it hears so", async () => {
    const t = await templateWith("Hello there, see you at the studio soon.");
    await submit(t.id);
    const hook = meta.templateUpdate(await metaNameOfRow(t.id), { status: "APPROVED" });
    expect((await deliver(h, hook)).statusCode).toBe(200);
    expect((await view(admin, t.id)).submissions[0]).toMatchObject({ status: "approved", reason: null });
    const notes = await decided(admin.id);
    expect(notes).toEqual([{ kind: "template_decided", title: `WhatsApp approved “${t.name}”.` }]);
    // The same webhook again changes nothing and says nothing again.
    await deliver(h, hook);
    expect(await decided(admin.id)).toHaveLength(1);
  });

  it("turned down: WhatsApp's reason, in LUME's words", async () => {
    const t = await templateWith("Hello there, see you at the studio soon.");
    await submit(t.id);
    await deliver(
      h,
      meta.templateUpdate(await metaNameOfRow(t.id), { status: "REJECTED", reason: "INVALID_FORMAT" }),
    );
    const s = (await view(admin, t.id)).submissions[0];
    expect(s.status).toBe("rejected");
    expect(s.reason).toBe(
      "WhatsApp found its format wrong: often a variable at the very start or end, or a sample that doesn't fit.",
    );
    const [note] = (await decided(admin.id)).slice(-1);
    expect(note!.title).toBe(`WhatsApp turned down “${t.name}”.`);
  });

  it("WhatsApp moves it to another category: LUME follows", async () => {
    const t = await templateWith("Hello there, see you at the studio soon.");
    await submit(t.id);
    await deliver(
      h,
      meta.templateUpdate(await metaNameOfRow(t.id), { status: "APPROVED", category: "UTILITY" }),
    );
    expect((await view(admin, t.id)).submissions[0]).toMatchObject({
      status: "approved",
      category: "UTILITY",
    });
  });

  it("a webhook that never came: the sweep asks WhatsApp", async () => {
    const t = await templateWith("Hello there, see you at the studio soon.");
    await submit(t.id);
    meta.templateUpdate(await metaNameOfRow(t.id), { status: "APPROVED" }); // the webhook is lost
    h.clock.advance(11 * 60_000);
    await sweepTemplates(h.ownerPool, {
      meta: { graphUrl: meta.url, version: meta.version },
      keyring: h.keyring,
      clock: () => h.clock.now,
    });
    expect((await view(admin, t.id)).submissions[0].status).toBe("approved");
  });

  it("edited after approval: the approved version stays as it was, and the edit is not approved", async () => {
    const t = await templateWith("Hello there, see you at the studio soon.");
    await submit(t.id);
    await deliver(h, meta.templateUpdate(await metaNameOfRow(t.id), { status: "APPROVED" }));
    const edit = await (
      await as(admin)
    ).inject({
      method: "PATCH",
      url: `/api/v1/templates/${t.id}`,
      payload: { body: "Hello there, see you at the studio this week." },
    });
    expect(edit.statusCode).toBe(200);
    expect((await view(admin, t.id)).submissions).toEqual([
      expect.objectContaining({ status: "approved", current: false }),
    ]);
    expect((await submit(t.id)).statusCode).toBe(202);
  });
});
