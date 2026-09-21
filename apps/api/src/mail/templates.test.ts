import { describe, expect, it } from "vitest";
import { inviteMail, resetMail } from "./templates";

describe("mail templates", () => {
  it("escapes names and never includes anything but the link", () => {
    const m = inviteMail({
      to: "r@x.com",
      name: "<script>Riya</script>",
      businessName: "Nupuur & Co",
      inviterName: "Tasneem",
      url: "https://lume.test/invite/abc",
      expiresAt: new Date("2026-09-24T09:00:00Z"),
    });
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;Riya&lt;/script&gt;");
    expect(m.html).toContain("Nupuur &amp; Co");
    expect(m.text).toContain("https://lume.test/invite/abc");
    expect(m.subject).toBe("Tasneem invited you to LUME for Nupuur & Co");
  });

  it("reset mail says it expires in 30 minutes", () => {
    expect(resetMail({ to: "a@b.c", businessName: "X", url: "https://lume.test/reset/t" }).text).toMatch(
      /30 minutes/,
    );
  });
});
