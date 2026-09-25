import { describe, expect, it } from "vitest";
import { describeActivity } from "./history";
import { testCatalog } from "./test-catalog";

const cat = testCatalog();
const a = (type: string, payload: Record<string, unknown> = {}) => ({
  id: "a",
  type,
  payload,
  occurredAt: "2026-09-24T10:00:00Z",
  user: { id: "u-tas", name: "Tasneem Shaikh" },
});

describe("describeActivity", () => {
  it("tells each kind of event in plain words, with who did it", () => {
    expect(describeActivity(a("stage_changed", { from: "s-new", to: "s-sent" }), cat)).toMatchObject({
      title: "Moved to Message sent",
      detail: "by Tasneem Shaikh",
    });
    expect(
      describeActivity(a("stage_changed", { to: "s-lost", lostReasonId: "r-price" }), cat),
    ).toMatchObject({
      title: "Marked as lost",
      detail: "Price · by Tasneem Shaikh",
      tone: "danger",
    });
    expect(describeActivity(a("stage_changed", { to: "s-won" }), cat)).toMatchObject({
      title: "Won",
      tone: "ok",
    });
    expect(describeActivity(a("assigned", { from: "u-riya", to: "u-tas" }), cat).title).toBe(
      "Handed to Tasneem Shaikh",
    );
    expect(describeActivity(a("assigned", { from: "u-riya", to: null }), cat).title).toBe("Unassigned");
    expect(describeActivity(a("contact_revealed"), cat).title).toBe("Contact revealed");
    expect(describeActivity(a("whatsapp_opened", { text: "Hi Aisha" }), cat)).toMatchObject({
      title: "WhatsApp opened",
      quote: "Hi Aisha",
    });
    expect(describeActivity(a("whatsapp_confirmed_sent"), cat).title).toBe("WhatsApp sent");
    expect(describeActivity(a("field_changed", { fields: ["name", "custom.struggles"] }), cat).title).toBe(
      "Edited Name, Struggles",
    );
    expect(describeActivity(a("lead_created", { source: "manual" }), cat).title).toBe("Lead added");
  });

  it("never throws on an event type or stage it doesn't know", () => {
    expect(describeActivity(a("something_new"), cat).title).toBe("Updated");
    expect(describeActivity(a("stage_changed", { to: "gone" }), cat).title).toBe("Moved to another stage");
    expect(describeActivity({ ...a("contact_revealed"), user: null }, cat).detail).toBeUndefined();
  });
});
