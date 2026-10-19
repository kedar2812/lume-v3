import { describe, expect, it } from "vitest";
import {
  digestMail,
  inviteMail,
  lockoutMail,
  opsAlertMail,
  resetMail,
  weeklyAnalyticsMail,
  type DigestItem,
} from "./templates";

const invite = (over: Partial<Parameters<typeof inviteMail>[0]> = {}) =>
  inviteMail({
    to: "r@x.com",
    name: "Riya",
    businessName: "Maya & Co",
    inviterName: "Leila Haddad",
    url: "https://lume.test/invite/abc",
    expiresAt: new Date("2026-10-22T10:42:00Z"),
    ...over,
  });

const every = () => [
  invite(),
  resetMail({ to: "a@b.c", businessName: "Maya & Co", url: "https://lume.test/reset/t" }),
  lockoutMail({
    to: "a@b.c",
    businessName: "Maya & Co",
    lockedEmailHint: "r…@x.com",
    url: "https://lume.test/s",
  }),
  digestMail({
    to: "a@b.c",
    firstName: "Riya",
    businessName: "Maya & Co",
    url: "https://lume.test/today",
    overdue: [{ who: "Aisha", what: "Call back", when: "Sun 11:30", url: "https://lume.test/leads?lead=1" }],
    today: [],
    assigned: 0,
    admin: null,
  }),
  weeklyAnalyticsMail({
    to: "a@b.c",
    firstName: "Riya",
    businessName: "Maya & Co",
    url: "https://lume.test/analytics",
    week: "last week (October 12 – 18)",
    tiles: ["New leads 42"],
    topPerson: null,
    dropStage: null,
    overdue: 0,
    insight: null,
  }),
  opsAlertMail({
    to: "a@b.c",
    businessName: "Maya & Co",
    words: "Backups stopped.",
    url: "https://lume.test/h",
  }),
];

describe("mail templates", () => {
  it("escapes names and never includes anything but the link", () => {
    const m = invite({ name: "<script>Riya</script>" });
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;Riya&lt;/script&gt;");
    expect(m.html).toContain("Maya &amp; Co");
    expect(m.text).toContain("https://lume.test/invite/abc");
    expect(m.subject).toBe("Leila Haddad invited you to LUME for Maya & Co");
  });

  it("reset mail says it expires in 30 minutes", () => {
    expect(resetMail({ to: "a@b.c", businessName: "X", url: "https://lume.test/reset/t" }).text).toMatch(
      /30 minutes/,
    );
  });

  it("an invite names the role, and when the link stops working on the business's clock", () => {
    const m = invite({ roleNames: ["Sales"], tz: "Asia/Kolkata" });
    for (const body of [m.html, m.text]) {
      expect(body).toContain("Sales");
      // 10:42 UTC is 4:12 pm in India.
      expect(body).toContain("Thursday, October 22 at 4:12 pm");
    }
    expect(m.html).toContain("Leila Haddad");
    expect(m.html).toContain(">LH<"); // the inviter's initials, as LUME shows people
  });

  it("every email is LUME's: the mark from its own server, the business, a preview line, and dark mode", () => {
    for (const m of every()) {
      expect(m.html).toContain('src="https://lume.test/lume-mark.png"');
      expect(m.html).toContain("Maya &amp; Co");
      expect(m.html).toContain("prefers-color-scheme:dark");
      expect(m.html).toMatch(/<div style="display:none[^"]*">[^<]{10,}/); // the preview line mail apps show
      expect(m.html).toContain('<meta name="viewport"');
    }
  });

  it("an email whose link isn't a full address still goes: LUME in words, no broken image", () => {
    const m = opsAlertMail({
      to: "a@b.c",
      businessName: "Maya & Co",
      words: "Backups stopped.",
      url: "/settings/health",
    });
    expect(m.html).not.toContain("<img");
    expect(m.html).toContain(">LUME<");
    expect(m.html).toContain('href="/settings/health"');
  });

  it("every style attribute stays whole: a font name in double quotes would end it early", () => {
    for (const m of every()) {
      const fonts = [...m.html.matchAll(/style="[^"]*?font:([^";]*)/g)].map((f) => f[1]!);
      expect(fonts.length).toBeGreaterThan(5);
      for (const f of fonts) expect(f).toMatch(/sans-serif$/);
    }
  });

  it("speaks as LUME, in plain words: no em dashes in what a person reads", () => {
    for (const m of every()) {
      const words = m.html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ");
      expect(words).not.toContain("—");
      expect(m.subject).not.toContain("—");
    }
  });

  it("the digest counts what's overdue, due and new, colours only what needs attention, and links every lead", () => {
    const item = (who: string, url?: string): DigestItem => ({
      who,
      what: "Call back",
      when: "11:30",
      ...(url ? { url } : {}),
    });
    const m = digestMail({
      to: "a@b.c",
      firstName: "Riya",
      businessName: "Maya & Co",
      url: "https://lume.test/today",
      overdue: [item("Aisha", "https://lume.test/leads?lead=1")],
      today: [item("Omar"), item("Sara")],
      assigned: 0,
      admin: null,
      day: "Monday, October 19",
    });
    expect(m.html).toContain("Monday, October 19");
    expect(m.html).toContain("1 of them overdue");
    expect(m.html).toContain('href="https://lume.test/leads?lead=1"');
    // Overdue in red, due today in amber, nothing new in grey.
    expect(m.html).toMatch(/color:#C62A30">1</);
    expect(m.html).toMatch(/color:#A15C00">2</);
    expect(m.html).toMatch(/color:#9AA0AC">0</);
  });
});
