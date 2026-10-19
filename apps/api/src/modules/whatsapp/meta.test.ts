import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { MetaError, metaClient } from "./meta";

/** WhatsApp's template endpoints (plan W3b-2 Task 3), against the fake Meta, which answers as Meta's docs say. */
let meta: MetaFake;
const TOKEN = "EAAG-business-token";
const WABA = "102290129340398";
const PHONE = "106540352242922";
const client = () => metaClient({ graphUrl: meta.url, version: meta.version }, TOKEN);
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as MetaError,
  );
const body = (text: string, example?: string[]) => ({
  type: "BODY",
  text,
  ...(example ? { example: { body_text: [example] } } : {}),
});
const template = (name: string, components: unknown[]) => ({
  name,
  language: "en",
  category: "MARKETING",
  components,
});

beforeAll(async () => {
  meta = await startMetaFake();
});
afterAll(() => meta.close());
beforeEach(() => {
  meta.templates.clear();
  meta.templatePageSize = 100;
  meta.templateNextUrl = null;
  meta.sent.length = 0;
});

describe("a file for a template's header", () => {
  it("goes up in WhatsApp's resumable upload, and comes back as the handle a template names", async () => {
    const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n");
    const handle = await client().uploadForTemplate(meta.appId, pdf, "application/pdf", "Brochure.pdf");
    expect(handle).toMatch(/^4::/);
    const [start, upload] = meta.calls.filter((c) => c.path.includes("upload")).slice(-2);
    expect(start!.path).toBe(`/${meta.version}/${meta.appId}/uploads`);
    expect(upload!.auth).toBe(`OAuth ${TOKEN}`);
    expect(meta.headerUploads.get(handle)).toEqual({ size: pdf.length, type: "application/pdf" });
  });
});

describe("creating a template", () => {
  it("WhatsApp keeps it for review", async () => {
    const r = await client().createTemplate(
      WABA,
      template("visit_v1", [body("Hi {{1}}, see you soon.", ["Aisha"])]),
    );
    expect(r).toEqual({ id: expect.any(String), status: "PENDING", category: "MARKETING" });
  });

  it("a variable without a sample is turned down, as Meta does", async () => {
    const e = await failure(
      client().createTemplate(WABA, template("visit_v2", [body("Hi {{1}}, see you soon.")])),
    );
    expect(e).toBeInstanceOf(MetaError);
    expect(e!.code).toBe(100);
  });
});

describe("reading templates back", () => {
  it("pages through WhatsApp's list and keeps only the ones asked for", async () => {
    for (const n of ["a_v1", "b_v1", "c_v1"])
      await client().createTemplate(WABA, template(n, [body("Hello there, see you soon.")]));
    meta.templatePageSize = 2;
    const got = await client().templates(WABA, ["a_v1", "c_v1"]);
    expect(got.map((t) => [t.name, t.status, t.language, t.category, t.reason])).toEqual([
      ["a_v1", "PENDING", "en", "MARKETING", null],
      ["c_v1", "PENDING", "en", "MARKETING", null],
    ]);
  });

  it("a next page somewhere that isn't Meta is never followed with the token", async () => {
    for (const n of ["a_v1", "b_v1"])
      await client().createTemplate(WABA, template(n, [body("Hello there, see you soon.")]));
    meta.templatePageSize = 1;
    meta.templateNextUrl = "https://evil.example.com/next";
    const e = await failure(client().templates(WABA, ["a_v1"]));
    expect(e?.kind).toBe("untrusted");
  });

  it("a rejection carries WhatsApp's reason", async () => {
    await client().createTemplate(WABA, template("a_v1", [body("Hello there, see you soon.")]));
    meta.templateUpdate("a_v1", { status: "REJECTED", reason: "INVALID_FORMAT" });
    expect((await client().templates(WABA, ["a_v1"]))[0]).toMatchObject({
      status: "REJECTED",
      reason: "INVALID_FORMAT",
    });
  });
});

describe("sending a template", () => {
  const send = (name: string, params: string[]) =>
    client().sendMessage(PHONE, {
      messaging_product: "whatsapp",
      to: "919876543210",
      type: "template",
      template: {
        name,
        language: { code: "en" },
        components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }],
      },
    });

  it("only an approved one, with as many values as it has variables", async () => {
    await client().createTemplate(WABA, template("visit_v1", [body("Hi {{1}}, see you soon.", ["Aisha"])]));
    expect((await failure(send("visit_v1", ["Aisha"])))?.code).toBe(132001);
    meta.templateUpdate("visit_v1", { status: "APPROVED" });
    expect((await failure(send("visit_v1", [])))?.code).toBe(132000);
    expect(await send("visit_v1", ["Aisha"])).toMatch(/^wamid\./);
    expect(meta.sent.map((m) => m.body.type)).toEqual(["template"]);
  });

  it("the status change comes as WhatsApp's webhook, for the account", async () => {
    await client().createTemplate(WABA, template("visit_v1", [body("Hi {{1}}, see you soon.", ["Aisha"])]));
    const id = meta.templates.get("visit_v1")!.id;
    expect(meta.templateUpdate("visit_v1", { status: "APPROVED", category: "UTILITY" })).toEqual({
      object: "whatsapp_business_account",
      entry: [
        {
          id: WABA,
          time: expect.any(Number),
          changes: [
            {
              field: "message_template_status_update",
              value: {
                event: "APPROVED",
                message_template_id: Number(id),
                message_template_name: "visit_v1",
                message_template_language: "en",
                reason: "NONE",
              },
            },
            {
              field: "template_category_update",
              value: {
                message_template_id: Number(id),
                message_template_name: "visit_v1",
                message_template_language: "en",
                previous_category: "MARKETING",
                new_category: "UTILITY",
              },
            },
          ],
        },
      ],
    });
  });
});
