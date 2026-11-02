import { describe, expect, it } from "vitest";
import { DEFAULT_AI_PROFILE } from "./profile";
import {
  cleanTemplateDrafts,
  templateDraftInput,
  templateDraftInstructions,
  templateDraftOutput,
  type TemplateDraftCtx,
} from "./template-draft";

/** LUME AI writes templates (owner, 2026-10-31): a prompt in, two or three options out, each one LUME could submit. */
const ctx = (o: Partial<TemplateDraftCtx> = {}): TemplateDraftCtx => ({
  business: "Brightpath Studio",
  prompt: "Follow up with leads who asked for pricing and went quiet",
  profile: {
    ...DEFAULT_AI_PROFILE,
    knows: {
      ...DEFAULT_AI_PROFILE.knows,
      about: "Interior design studio in Pune.",
      prices: [{ id: "p1", item: "Modular kitchen", price: 380000, unit: "per kitchen", notes: "" }],
    },
  },
  currency: "INR",
  variables: [
    { token: "lead.first_name", label: "First name" },
    { token: "owner.first_name", label: "Owner's first name" },
    { token: "business.name", label: "Business name" },
  ],
  existing: ["First hello"],
  ...o,
});
const option = (o: Partial<{ name: string; body: string; category: string; why: string }> = {}) => ({
  name: "Gentle nudge",
  category: "follow_up",
  body: "Hi {{lead.first_name}}, just checking in on the kitchen plan. Shall I send a few designs?",
  why: "Short and warm, with an easy yes.",
  ...o,
});
// The guard on its own: any number of answers, each checked as LUME would (the schema's 2-3 is tested above).
const clean = (options: ReturnType<typeof option>[], c = ctx()) =>
  cleanTemplateDrafts({ options } as Parameters<typeof cleanTemplateDrafts>[0], c);

describe("LUME AI's template drafts", () => {
  it("asks for two or three, and keeps those LUME could submit as they are", () => {
    expect(templateDraftOutput.safeParse({ options: [option()] }).success).toBe(false);
    expect(templateDraftOutput.safeParse({ options: [option(), option(), option(), option()] }).success).toBe(
      false,
    );
    const out = clean([
      option(),
      option({
        name: "Designs ready",
        body: "Hi {{lead.first_name}}, your designs are ready to see. When suits you?",
      }),
    ]);
    expect(out.map((o) => o.name)).toEqual(["Gentle nudge", "Designs ready"]);
  });

  it("drops one with a variable LUME doesn't have", () => {
    const out = clean([
      option(),
      option({ name: "Bad", body: "Hi {{lead.budget}}, still keen on a visit?" }),
    ]);
    expect(out.map((o) => o.name)).toEqual(["Gentle nudge"]);
  });

  it("drops one with a made-up blank to fill: [day] at [time], <name>, {date} (live test 2026-11-02)", () => {
    const out = clean([
      option(),
      option({
        name: "Square",
        body: "Hi {{lead.first_name}}, your call is on [day] at [time]. See you then?",
      }),
      option({ name: "Angle", body: "Hi {{lead.first_name}}, see you on <date>. All good?" }),
      option({ name: "Brace", body: "Hi {{lead.first_name}}, see you on {date}. All good?" }),
      // Brackets that are words, not blanks, stay.
      option({
        name: "Aside",
        body: "Hi {{lead.first_name}}, the plan (with two options) is ready. Shall I send it?",
      }),
    ]);
    expect(out.map((o) => o.name)).toEqual(["Gentle nudge", "Aside"]);
    expect(templateDraftInstructions(ctx())).toMatch(/never a blank in brackets/i);
  });

  it("drops one WhatsApp would turn down: a variable first or last, two together", () => {
    const out = clean([
      option(),
      option({ name: "Starts", body: "{{lead.first_name}}, still keen on the kitchen?" }),
      option({ name: "Ends", body: "A quick hello from {{business.name}}" }),
    ]);
    expect(out.map((o) => o.name)).toEqual(["Gentle nudge"]);
    expect(
      clean([option({ body: "Hi {{lead.first_name}} {{owner.first_name}} here, any questions?" })]),
    ).toEqual([]);
  });

  it("drops a price not in the price list, and any discount it wasn't given", () => {
    const out = clean([
      option(),
      option({
        name: "Listed",
        body: "Hi {{lead.first_name}}, a modular kitchen is ₹3,80,000. Want a visit?",
      }),
      option({ name: "Made up", body: "Hi {{lead.first_name}}, kitchens start at ₹2,50,000. Want a visit?" }),
      option({ name: "Offer", body: "Hi {{lead.first_name}}, 20% off this week only. Want a visit?" }),
    ]);
    expect(out.map((o) => o.name)).toEqual(["Gentle nudge", "Listed"]);
  });

  it("drops a copy of another option, and names one like an existing template apart", () => {
    const out = clean([option(), option({ name: "First hello" }), option({ name: "Gentle nudge" })]);
    expect(out.map((o) => o.name)).toEqual(["Gentle nudge"]);
  });

  it("tells LUME AI the rules, the variables it may use, the price list and the prompt; never a lead's details", () => {
    const say = templateDraftInstructions(ctx());
    for (const words of ["{{lead.first_name}}", "{{business.name}}", "1,024", "Modular kitchen", "380000"])
      expect(say).toContain(words);
    expect(say).toMatch(/never start or end the message with a variable/i);
    expect(say).toMatch(/two or three/i);
    const input = templateDraftInput(ctx());
    expect(input).toContain("Follow up with leads who asked for pricing and went quiet");
    expect(input).toContain("First hello");
  });
});
