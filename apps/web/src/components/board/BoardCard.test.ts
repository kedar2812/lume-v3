import { describe, expect, it } from "vitest";
import { inStage, inStageWords } from "./BoardCard";
import type { Lead } from "@/lib/leads/types";

const at = (daysAgo: number) =>
  ({
    stageEnteredAt: new Date(Date.parse("2026-10-07T12:00:00Z") - daysAgo * 86_400_000).toISOString(),
  }) as Lead;
const now = Date.parse("2026-10-07T12:00:00Z");

describe("how long a card has waited in its stage, said so a glance understands it", () => {
  it("says what the number is", () => {
    expect(inStage(at(0), now)).toBe("Moved today");
    expect(inStage(at(1), now)).toBe("1d in stage");
    expect(inStage(at(152), now)).toBe("152d in stage");
  });
  it("in full for the tooltip and screen readers", () => {
    expect(inStageWords(at(1), now)).toBe("In this stage for 1 day");
    expect(inStageWords(at(152), now)).toBe("In this stage for 152 days");
    expect(inStageWords(at(0), now)).toBe("Moved to this stage today");
  });
});
