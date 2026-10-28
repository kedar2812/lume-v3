import { describe, expect, it } from "vitest";
import type { RenderContext } from "../messaging/render";
import { metaCategoryOf, metaNameOf, paramsFor, templateProblems, toMetaTemplate } from "./templates";

const MB = 1024 * 1024;
const CTX: RenderContext = {
  lead: { name: "Aisha Khan", custom: {} },
  owner: { name: "Riya Sharma" },
  business: { name: "Acme Studio", currency: "INR", timezone: "Asia/Kolkata" },
  fields: [],
  people: [],
};

describe("LUME's categories as WhatsApp's (W3b-2 Task 1)", () => {
  it("a reminder is a utility message; everything else is marketing", () => {
    expect(metaCategoryOf("reminder")).toBe("UTILITY");
    for (const c of ["first_touch", "follow_up", "re_engagement", "custom"] as const)
      expect(metaCategoryOf(c)).toBe("MARKETING");
  });
});

describe("a template's name at WhatsApp", () => {
  it("lowercase words joined by underscores, its version last", () => {
    expect(metaNameOf("First hello · interiors", 3)).toBe("first_hello_interiors_v3");
    expect(metaNameOf("Café visit 2", 1)).toBe("cafe_visit_2_v1");
  });
  it("a name with no letters or digits still has one", () => {
    expect(metaNameOf("✨ · ✨", 3)).toBe("template_v3");
  });
  it("never longer than WhatsApp takes", () => {
    expect(metaNameOf("a".repeat(900), 12).length).toBeLessThanOrEqual(512);
    expect(metaNameOf("a".repeat(900), 12).endsWith("_v12")).toBe(true);
  });
});

describe("what WhatsApp would turn down, said by LUME first", () => {
  it("a good template has no problems", () => {
    expect(templateProblems("Hi {{lead.first_name}}, your visit is confirmed. See you soon!")).toEqual([]);
  });
  it("empty, or over 1,024 characters", () => {
    expect(templateProblems("  ")).toEqual(["Write the message first."]);
    expect(templateProblems("word ".repeat(300))).toEqual([
      "WhatsApp templates can be up to 1,024 characters.",
    ]);
  });
  it("starting or ending with a variable", () => {
    const words = "Add words before and after it.";
    expect(templateProblems("{{lead.first_name}}, your visit is confirmed today.")).toEqual([
      `WhatsApp doesn't take a template that starts with a variable. ${words}`,
    ]);
    expect(templateProblems("Your visit is confirmed for today, {{lead.first_name}}")).toEqual([
      `WhatsApp doesn't take a template that ends with a variable. ${words}`,
    ]);
  });
  it("two variables side by side", () => {
    expect(templateProblems("Hello there {{lead.first_name}} {{lead.name}}, welcome to our studio.")).toEqual(
      ["Put words between two variables."],
    );
  });
  it("more variables than half its words", () => {
    expect(templateProblems("Hi {{lead.first_name}} at {{business.name}} on {{meeting.date}} ok")).toEqual([
      "Too many variables for so few words. Add words around them.",
    ]);
  });
  it("a header file of the wrong kind or too big", () => {
    const body = "Here is our brochure, as promised. Have a look!";
    expect(templateProblems(body, { kind: "image", mime: "image/png", size: 4 * MB })).toEqual([]);
    expect(templateProblems(body, { kind: "image", mime: "image/webp", size: MB })).toEqual([
      "A photo at the top must be a JPEG or PNG.",
    ]);
    expect(templateProblems(body, { kind: "image", mime: "image/jpeg", size: 6 * MB })).toEqual([
      "A photo at the top can be up to 5 MB.",
    ]);
    expect(templateProblems(body, { kind: "video", mime: "video/3gpp", size: MB })).toEqual([
      "A video at the top must be an MP4.",
    ]);
    expect(templateProblems(body, { kind: "video", mime: "video/mp4", size: 17 * MB })).toEqual([
      "A video at the top can be up to 16 MB.",
    ]);
    expect(
      templateProblems(body, {
        kind: "document",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: MB,
      }),
    ).toEqual(["A document at the top must be a PDF."]);
    expect(templateProblems(body, { kind: "document", mime: "application/pdf", size: 24 * MB })).toEqual([]);
  });
});

describe("a template as WhatsApp takes it", () => {
  it("LUME's named variables become numbered ones in order, with readable examples", () => {
    const r = toMetaTemplate({
      name: "Visit confirmed",
      version: 2,
      language: "en",
      category: "UTILITY",
      body: "Hi {{lead.first_name}}, your {{ meeting.date }} visit is confirmed, {{lead.first_name}}.",
    });
    expect(r.tokens).toEqual(["lead.first_name", "meeting.date"]);
    expect(r.payload).toEqual({
      name: "visit_confirmed_v2",
      language: "en",
      category: "UTILITY",
      components: [
        {
          type: "BODY",
          text: "Hi {{1}}, your {{2}} visit is confirmed, {{1}}.",
          example: { body_text: [["Aisha", "October 24, Saturday"]] },
        },
      ],
    });
  });

  it("no variables: no example; a header file goes first, by its handle", () => {
    const r = toMetaTemplate({
      name: "Brochure",
      version: 1,
      language: "en",
      category: "MARKETING",
      body: "Here is our brochure, as promised.",
      header: { kind: "document", handle: "4::aGVsbG8=" },
    });
    expect(r.tokens).toEqual([]);
    expect(r.payload.components).toEqual([
      { type: "HEADER", format: "DOCUMENT", example: { header_handle: ["4::aGVsbG8="] } },
      { type: "BODY", text: "Here is our brochure, as promised." },
    ]);
  });
});

describe("a lead's values for the numbered variables", () => {
  it("in order, and what's missing named", () => {
    expect(paramsFor(["lead.first_name", "owner.first_name"], CTX)).toEqual({
      values: ["Aisha", "Riya"],
      missing: [],
    });
    expect(paramsFor(["lead.first_name", "meeting.date"], CTX)).toEqual({
      values: ["Aisha", ""],
      missing: ["meeting.date"],
    });
  });

  it("a value with a line break, a tab or a run of spaces goes as one line WhatsApp accepts (review C5)", () => {
    const ctx = { ...CTX, business: { ...CTX.business, name: "Acme\nStudio\t\tand     Sons\r\n" } };
    expect(paramsFor(["business.name"], ctx).values).toEqual(["Acme Studio and Sons"]);
  });
});
