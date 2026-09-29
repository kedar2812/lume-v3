import { describe, expect, it } from "vitest";
import { describeActivity } from "./history";
import { testCatalog } from "./test-catalog";
import type { Activity } from "./types";

const cat = testCatalog();
const a = (type: string, payload: Record<string, unknown> = {}) => ({
  id: "a",
  type,
  payload,
  occurredAt: "2026-09-24T10:00:00Z",
  user: { id: "u-tas", name: "Leila Haddad" },
});

describe("describeActivity", () => {
  it("tells each kind of event in plain words, with who did it", () => {
    expect(describeActivity(a("stage_changed", { from: "s-new", to: "s-sent" }), cat)).toMatchObject({
      title: "Moved to Message sent",
      detail: "by Leila Haddad",
    });
    expect(
      describeActivity(a("stage_changed", { to: "s-lost", lostReasonId: "r-price" }), cat),
    ).toMatchObject({
      title: "Marked as lost",
      detail: "Price · by Leila Haddad",
      tone: "danger",
    });
    expect(describeActivity(a("stage_changed", { to: "s-won" }), cat)).toMatchObject({
      title: "Won",
      tone: "ok",
    });
    expect(describeActivity(a("assigned", { from: "u-riya", to: "u-tas" }), cat).title).toBe(
      "Handed to Leila Haddad",
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

  it("a send says which template, a reply is one line, and a lost lead coming back says where (4A)", () => {
    expect(describeActivity(a("whatsapp_confirmed_sent", { template: "Gentle nudge" }), cat)).toMatchObject({
      title: "WhatsApp sent",
      detail: "from “Gentle nudge” · by Leila Haddad",
      tone: "ok",
    });
    expect(describeActivity(a("reply_logged"), cat)).toMatchObject({
      title: "They replied",
      detail: "by Leila Haddad",
      tone: "ok",
    });
    expect(describeActivity(a("reopened", { from: "s-lost", to: "s-new" }), cat)).toMatchObject({
      title: "Reopened",
      detail: "into New · by Leila Haddad",
    });
  });

  it("says where an imported lead came from, and when it enquired again", () => {
    const first = describeActivity(a("imported", { file: "march.csv", row: 14 }), cat);
    expect(first.title).toBe("Imported");
    expect(first.detail).toMatch(/^from march\.csv, row 14/);
    const again = describeActivity(
      a("imported_again", { file: "april.csv", row: 3, extraPhones: ["055 ••• ••44"] }),
      cat,
    );
    expect(again.title).toBe("Enquired again");
    expect(again.detail).toMatch(/^from april\.csv, row 3/);
    expect(again.quote).toBe("Also gave 055 ••• ••44");
  });

  it("a sheet row finished after it was first read says it was filled in", () => {
    const d = describeActivity(
      a("sheet_row_updated", { sourceId: "s1", sheet: "Website enquiries", row: 9 }),
      cat,
    );
    expect(d.title).toBe("Filled in from the sheet");
    expect(d.detail).toMatch(/^from Website enquiries, row 9/);
  });

  it("a lead from a Google Sheet says which sheet and row", () => {
    const d = describeActivity(a("imported", { sourceId: "s1", sheet: "Website enquiries", row: 14 }), cat);
    expect(d.title).toBe("Imported");
    expect(d.detail).toMatch(/^from Website enquiries, row 14/);
  });

  it("a lead from a webhook says which webhook", () => {
    const d = describeActivity(a("imported", { sourceId: "w1", webhook: "Landing page", event: 12 }), cat);
    expect(d.title).toBe("Imported");
    expect(d.detail).toMatch(/^from Landing page/);
    expect(d.detail).not.toMatch(/row/);
  });

  it("follow-ups: set (with its time), moved, done and cancelled", () => {
    const set = describeActivity(
      a("follow_up_set", { taskId: "t1", title: "Call back", dueAt: "2026-09-29T06:00:00.000Z" }),
      cat,
    );
    expect(set.title).toBe("Follow-up set");
    expect(set.detail).toMatch(/^“Call back”, 29 Sept? 2026/);
    expect(
      describeActivity(a("follow_up_changed", { title: "Call back", dueAt: "2026-09-30T06:00:00.000Z" }), cat)
        .title,
    ).toBe("Follow-up moved");
    expect(describeActivity(a("follow_up_done", { title: "Call back" }), cat)).toMatchObject({
      title: "Follow-up done",
      tone: "ok",
    });
    expect(describeActivity(a("follow_up_cancelled", { title: "Call back" }), cat).title).toBe(
      "Follow-up cancelled",
    );
  });

  it("never throws on an event type or stage it doesn't know", () => {
    expect(describeActivity(a("something_new"), cat).title).toBe("Updated");
    expect(describeActivity(a("stage_changed", { to: "gone" }), cat).title).toBe("Moved to another stage");
    expect(describeActivity({ ...a("contact_revealed"), user: null }, cat).detail).toBeUndefined();
  });
});

describe("LUME's own work, in the lead's history (3C Task 6)", () => {
  const cat = testCatalog();
  const auto = (payload: Record<string, unknown>, user: Activity["user"] = null): Activity =>
    ({ id: "a", type: "automation", payload, occurredAt: "2026-09-28T10:00:00Z", user }) as Activity;
  const who = cat.people[0]!;
  it("says what LUME did, and why it couldn't", () => {
    expect(
      describeActivity(
        auto({ rule: "create_task", result: "done", assigneeId: who.id, title: "Send the plan" }),
        cat,
      ),
    ).toMatchObject({ title: "LUME set a follow-up", detail: expect.stringContaining(`for ${who.name}`) });
    expect(
      describeActivity(auto({ rule: "create_task", result: "skipped", reason: "no_owner" }), cat),
    ).toMatchObject({
      title: "LUME couldn't set a follow-up",
      detail: "this lead has no owner",
    });
    expect(
      describeActivity(auto({ rule: "cancel_open_tasks", result: "done", cancelled: 2 }), cat).title,
    ).toBe("LUME cleared 2 open follow-ups");
    expect(
      describeActivity(auto({ rule: "cancel_open_tasks", result: "done", cancelled: 0 }), cat).title,
    ).toBe("No open follow-ups to clear");
    expect(describeActivity(auto({ rule: "notify", result: "done", told: [who.id] }), cat).title).toBe(
      `LUME told ${who.name}`,
    );
    expect(describeActivity(auto({ rule: "no_touch", result: "done", days: 7 }), cat).title).toBe(
      "LUME set a follow-up: no contact for 7 days",
    );
  });
});
