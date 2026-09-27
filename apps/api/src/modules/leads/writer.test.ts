import { describe, expect, it } from "vitest";
import { mergeFill } from "./writer";
import type { LeadRow } from "./serialize";

const lead = (over: Partial<LeadRow> = {}): LeadRow =>
  ({
    id: "l1",
    pipelineId: "p1",
    stageId: "s-new",
    ownerId: null,
    name: "Aisha",
    phoneRaw: null,
    phoneE164: null,
    phoneCountryIso: null,
    phoneStatus: "missing",
    email: "a@x.com",
    instagramHandle: null,
    value: null,
    leadCreatedAt: "2026-01-02",
    custom: { tier: "o-gold" },
    wonAt: null,
    lostAt: null,
    version: 3,
    ...over,
  }) as LeadRow;
const contact = {
  phoneRaw: "0501234567",
  phoneE164: "+971501234567",
  phoneCountryIso: "AE",
  phoneStatus: "valid" as const,
  email: "b@x.com",
  instagramHandle: "aisha",
};
const draft = {
  contact,
  value: 4500,
  leadCreatedAt: "2025-12-01",
  ownerId: "u-riya",
  custom: { tier: "o-silver", paid: true },
  tagIds: ["t-vip"],
};

describe("mergeFill (spec §6.9)", () => {
  it("fills only what's empty, and never overwrites what the team typed", () => {
    const { fill, filled } = mergeFill(lead(), draft, ["t-hot"], null);
    expect(fill.phone).toEqual(contact);
    expect(fill.email).toBeUndefined(); // the lead already has one
    expect(fill.instagram).toBe("aisha");
    expect(fill.value).toBe(4500);
    expect(fill.leadCreatedAt).toBeUndefined(); // the first appearance stays the origin
    expect(fill.ownerId).toBe("u-riya"); // unassigned counts as empty
    expect(fill.custom).toEqual({ paid: true }); // tier kept
    expect(fill.tagIds).toEqual(["t-vip"]); // added to t-hot, not replacing it
    expect(filled).toEqual(["phone", "instagram", "value", "owner", "paid", "tags"]);
  });

  it("keeps an existing phone even when it's unreadable (the bulk fix handles those)", () => {
    const { fill } = mergeFill(lead({ phoneRaw: "0501", phoneStatus: "invalid" }), draft, [], null);
    expect(fill.phone).toBeUndefined();
  });

  it("never changes an existing owner", () => {
    expect(mergeFill(lead({ ownerId: "u-tas" }), draft, [], null).fill.ownerId).toBeUndefined();
  });

  it("reopens a closed lead only when asked, and only a closed one", () => {
    expect(mergeFill(lead({ lostAt: new Date() }), draft, [], "s-new").fill.reopenTo).toEqual({
      stageId: "s-new",
    });
    expect(mergeFill(lead(), draft, [], "s-new").fill.reopenTo).toBeUndefined();
    expect(mergeFill(lead({ wonAt: new Date() }), draft, [], null).fill.reopenTo).toBeUndefined();
  });

  it("treats an empty list or empty string as empty", () => {
    const { fill } = mergeFill(
      lead({ custom: { struggles: [], note: "" } }),
      { ...draft, custom: { struggles: ["o-conf"], note: "hi" } },
      [],
      null,
    );
    expect(fill.custom).toEqual({ struggles: ["o-conf"], note: "hi" });
  });
});
