import { describe, expect, it } from "vitest";
import { suggestFor } from "./order";

const LOST = ["s-lost"];

describe("suggestFor (4C): the kind of message a view's leads want", () => {
  it("lost leads: Re-engagement", () => {
    expect(suggestFor({ lostDaysAgo: "30" }, LOST)).toBe("re_engagement");
    expect(suggestFor({ lostReasonId: "r1" }, LOST)).toBe("re_engagement");
    expect(suggestFor({ stageId: "s-lost" }, LOST)).toBe("re_engagement");
  });
  it("a lost stage among others isn't a lost-leads view", () => {
    expect(suggestFor({ stageId: "s-new,s-lost" }, LOST)).toBeUndefined();
  });
  it("gone quiet, or a follow-up overdue: Follow-up", () => {
    expect(suggestFor({ noReplyDays: "3" }, LOST)).toBe("follow_up");
    expect(suggestFor({ followUpOverdue: "true" }, LOST)).toBe("follow_up");
    expect(suggestFor({ followUpOverdue: "false" }, LOST)).toBeUndefined();
  });
  it("just arrived: First touch; anything else: no suggestion", () => {
    expect(suggestFor({ createdDays: "1" }, LOST)).toBe("first_touch");
    expect(suggestFor({ ownerId: "me", sort: "name" }, LOST)).toBeUndefined();
  });
});
