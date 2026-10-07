import { describe, expect, it } from "vitest";
import { TEMPLATE_CATEGORIES, VARIABLES, render, waFormat, type RenderContext } from "./render";

const people = [
  { id: "u-riya", name: "Riya Sharma" },
  { id: "u-omar", name: "Omar Ali" },
];
const fields: RenderContext["fields"] = [
  {
    key: "package",
    type: "select",
    options: [
      { id: "o-gold", label: "Gold" },
      { id: "o-basic", label: "Basic" },
    ],
  },
  {
    key: "interests",
    type: "multi_select",
    options: [
      { id: "o-yoga", label: "Yoga" },
      { id: "o-pilates", label: "Pilates" },
      { id: "o-run", label: "Running" },
    ],
  },
  { key: "call_on", type: "date" },
  { key: "call_at", type: "datetime" },
  { key: "budget", type: "currency" },
  { key: "sessions", type: "number" },
  { key: "paid", type: "boolean" },
  { key: "coach", type: "user" },
  { key: "story", type: "long_text" },
  { key: "city", type: "text" },
  { key: "alt_phone", type: "phone" },
  { key: "alt_email", type: "email" },
  { key: "site", type: "url" },
  { key: "insta", type: "instagram" },
];
const ctx = (tz: string, custom: Record<string, unknown> = {}): RenderContext => ({
  lead: {
    name: "Aisha Khan",
    custom: {
      package: "o-gold",
      interests: ["o-yoga", "o-pilates", "o-run"],
      call_on: "2026-10-12",
      call_at: "2026-10-12T20:30:00Z",
      budget: 1200,
      sessions: 8,
      paid: true,
      coach: "u-omar",
      story: "Wants to run a 10k",
      city: "Dubai",
      alt_phone: "+971501234567",
      alt_email: "aisha@x.test",
      site: "https://aisha.example",
      insta: "aisha.k",
      ...custom,
    },
  },
  owner: { name: "Riya Sharma" },
  business: { name: "Brightpath Studio", currency: "AED", timezone: tz },
  fields,
  people,
});

describe("render (4A Task 1)", () => {
  it("fills the lead's, the owner's and the business's names", () => {
    const r = render(
      "Hi {{lead.first_name}}, it's {{owner.first_name}} from {{business.name}}.",
      ctx("Asia/Dubai"),
    );
    expect(r).toEqual({ text: "Hi Aisha, it's Riya from Brightpath Studio.", missing: [] });
    expect(render("{{ lead.name }}", ctx("Asia/Dubai")).text).toBe("Aisha Khan"); // spaces inside the braces
  });

  it("every custom field type, as people read it", () => {
    const t = (key: string, tz = "Asia/Dubai") => render(`{{lead.custom.${key}}}`, ctx(tz)).text;
    expect(t("package")).toBe("Gold");
    expect(t("interests")).toBe("Yoga, Pilates and Running");
    expect(t("call_on")).toBe("12 Oct");
    expect(t("budget")).toBe("AED 1,200");
    expect(render("{{lead.custom.budget}}", ctx("Asia/Dubai", { budget: 1250.5 })).text).toBe("AED 1,250.50");
    // Money in its own local form: the rupee sign, the dollar sign (AED has none in English, so its code).
    const inCurrency = (currency: string, budget: number) =>
      render("{{lead.custom.budget}}", {
        ...ctx("Asia/Kolkata", { budget }),
        business: { name: "B", currency, timezone: "Asia/Kolkata" },
      }).text;
    expect(inCurrency("INR", 5000)).toBe("₹5,000");
    // A message to an Indian customer groups rupees in lakhs, as they read them.
    expect(inCurrency("INR", 150000)).toBe("₹1,50,000");
    expect(inCurrency("USD", 1250.5)).toBe("$1,250.50");
    expect(t("sessions")).toBe("8");
    expect(t("paid")).toBe("Yes");
    expect(render("{{lead.custom.paid}}", ctx("Asia/Dubai", { paid: false })).text).toBe("No");
    expect(t("coach")).toBe("Omar");
    expect(t("story")).toBe("Wants to run a 10k");
    expect(t("city")).toBe("Dubai");
  });

  it("a date and time in the business's own timezone", () => {
    const at = (tz: string) => render("{{lead.custom.call_at}}", ctx(tz)).text;
    expect(at("Asia/Dubai")).toBe("13 Oct, 00:30");
    expect(at("Asia/Kolkata")).toBe("13 Oct, 02:00");
    expect(at("Europe/London")).toBe("12 Oct, 21:30");
  });

  it("never a contact: phone, email, web and Instagram fields don't render", () => {
    const r = render(
      "{{lead.custom.alt_phone}} {{lead.custom.alt_email}} {{lead.custom.site}} {{lead.custom.insta}}",
      ctx("Asia/Dubai"),
    );
    expect(r.text).not.toMatch(/971|aisha@|example|aisha\.k/);
    expect(r.missing).toEqual([
      "lead.custom.alt_phone",
      "lead.custom.alt_email",
      "lead.custom.site",
      "lead.custom.insta",
    ]);
  });

  it("what's missing is listed once, in order; an unknown variable stays as written", () => {
    const r = render(
      "{{lead.custom.city}} {{lead.custom.gone}} {{meeting.date}} {{lead.custom.gone}} {{nonsense}}",
      ctx("Asia/Dubai", { city: "" }),
    );
    expect(r.missing).toEqual(["lead.custom.city", "lead.custom.gone", "meeting.date", "nonsense"]);
    expect(r.text).toBe(
      "{{lead.custom.city}} {{lead.custom.gone}} {{meeting.date}} {{lead.custom.gone}} {{nonsense}}",
    );
    expect(render("Hi {{owner.first_name}}", { ...ctx("Asia/Dubai"), owner: null }).missing).toEqual([
      "owner.first_name",
    ]);
  });

  it("the picker offers every non-contact field, and meeting details as needing Calendar", () => {
    const tokens = VARIABLES(fields).map((v) => v.token);
    expect(tokens).toContain("lead.first_name");
    expect(tokens).toContain("business.name");
    expect(tokens).toContain("lead.custom.package");
    expect(tokens).not.toContain("lead.custom.alt_phone");
    expect(tokens).not.toContain("lead.custom.insta");
    expect(VARIABLES(fields).find((v) => v.token === "meeting.date")).toMatchObject({ needs: "calendar" });
  });

  it("5C: a meeting's date (month first, owner 2026-10-01) and time on the business's clock, and its link", () => {
    const at = (startsAt: string, link: string | null = "https://meet.example/abc") => ({
      ...ctx("Asia/Dubai"),
      meeting: { startsAt, link },
    });
    expect(
      render("{{meeting.date}} at {{meeting.time}}: {{meeting.link}}", at("2026-10-01T06:30:00Z")).text,
    ).toBe("October 1, Thursday at 10:30 am: https://meet.example/abc");
    // across midnight in the business's zone
    expect(render("{{meeting.date}} {{meeting.time}}", at("2026-10-01T21:05:00Z")).text).toBe(
      "October 2, Friday 1:05 am",
    );
    expect(render("{{meeting.time}}", at("2026-10-01T08:00:00Z")).text).toBe("12 pm");
    expect(render("{{meeting.link}}", at("2026-10-01T06:30:00Z", null)).missing).toEqual(["meeting.link"]);
  });

  it("5C: with no meeting, its details are missing, as any variable with nothing to say", () => {
    expect(render("{{meeting.date}} {{meeting.time}}", ctx("Asia/Dubai")).missing).toEqual([
      "meeting.date",
      "meeting.time",
    ]);
    expect(render("{{meeting.date}}", { ...ctx("Asia/Dubai"), meeting: null }).missing).toEqual([
      "meeting.date",
    ]);
  });

  it("WhatsApp's *bold* and _italic_ runs, and unclosed marks left as text", () => {
    expect(waFormat("Hi *Aisha*, _see you_ soon")).toEqual([
      { t: "Hi " },
      { t: "Aisha", b: true },
      { t: ", " },
      { t: "see you", i: true },
      { t: " soon" },
    ]);
    expect(waFormat("2 * 3 = 6 and a_b")).toEqual([{ t: "2 * 3 = 6 and a_b" }]);
  });

  it("five categories, in order, with their names", () => {
    expect(TEMPLATE_CATEGORIES.map((c) => c.label)).toEqual([
      "First touch",
      "Follow-up",
      "Reminder",
      "Re-engagement",
      "Custom",
    ]);
  });
});
