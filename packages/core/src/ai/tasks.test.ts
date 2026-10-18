import { describe, expect, it } from "vitest";
import {
  catchUpOutput,
  cleanNextStep,
  inputFor,
  instructionsFor,
  nextStepOutput,
  trimHistory,
  type LeadFacts,
  type NextStep,
} from "./tasks";

const facts = (over: Partial<LeadFacts> = {}): LeadFacts => ({
  firstName: "Sneha",
  stage: { id: "s-new", name: "New enquiry" },
  stages: [
    { id: "s-new", name: "New enquiry", kind: "open" },
    { id: "s-visit", name: "Site visit booked", kind: "open" },
    { id: "s-won", name: "Project signed", kind: "won" },
    { id: "s-lost", name: "Lost", kind: "lost" },
  ],
  lostReasons: [{ id: "r-price", label: "Price too high" }],
  tags: [
    { id: "t-nri", label: "NRI client" },
    { id: "t-arch", label: "architect referral" },
  ],
  fields: [{ label: "Scope of work", value: "Modular kitchen" }],
  history: [{ at: "2026-10-17T10:00:00.000Z", kind: "note", text: "Asked for the 3D design first." }],
  timezone: "Asia/Dubai",
  now: "2026-10-18T06:00:00.000Z", // 10:00 in Dubai
  ...over,
});

const step = (over: Partial<NextStep> = {}): NextStep => ({
  summary: "Wants a site visit on Saturday.",
  stageId: null,
  followUp: null,
  lostReasonId: null,
  tagIds: [],
  decisionMaker: null,
  ...over,
});

describe("LUME AI's tasks", () => {
  it("never asks for contacts: the input carries only the facts given, and no contact keys exist on them", () => {
    const text = inputFor("next_step", facts(), "Talked for 20 minutes, call back Thursday.");
    expect(text).toContain("Sneha");
    expect(text).toContain("Talked for 20 minutes, call back Thursday.");
    expect(text).not.toMatch(/\+\d{6,}|@|https?:/);
    // @ts-expect-error a phone is not a fact LUME AI is given
    facts({ phone: "+971501234567" });
  });

  it("drops ids the business doesn't have, and a lost reason unless the stage is a lost one", () => {
    const out = cleanNextStep(
      step({ stageId: "s-other", tagIds: ["t-nri", "t-nope"], lostReasonId: "r-price" }),
      facts(),
    );
    expect(out.stageId).toBeNull();
    expect(out.tagIds).toEqual(["t-nri"]);
    expect(out.lostReasonId).toBeNull();
    const lost = cleanNextStep(step({ stageId: "s-lost", lostReasonId: "r-price" }), facts());
    expect(lost).toMatchObject({ stageId: "s-lost", lostReasonId: "r-price" });
    expect(cleanNextStep(step({ stageId: "s-lost", lostReasonId: "r-x" }), facts()).lostReasonId).toBeNull();
  });

  it("never suggests a follow-up in the past, on the business's clock", () => {
    const at = (local: string) =>
      cleanNextStep(step({ followUp: { at: local, title: "Call back" } }), facts()).followUp;
    expect(at("2026-10-18T09:30")).toBeNull(); // 9:30 in Dubai, it's 10:00 there
    expect(at("2026-10-18T10:00")).toBeNull();
    expect(at("2026-10-18T11:00")).toEqual({ at: "2026-10-18T11:00", title: "Call back" });
    expect(at("2026-13-40T11:00")).toBeNull(); // not a date
    expect(at("tomorrow")).toBeNull();
  });

  it("keeps the same tag once, and at most three", () => {
    const out = cleanNextStep(step({ tagIds: ["t-nri", "t-nri", "t-arch"] }), facts());
    expect(out.tagIds).toEqual(["t-nri", "t-arch"]);
  });

  it("trims history to the 20 newest items and 4,000 characters, dropping the oldest first", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      at: new Date(Date.UTC(2026, 9, 1, i)).toISOString(),
      kind: "note" as const,
      text: `note ${i} ` + "x".repeat(300),
    }));
    const kept = trimHistory(many);
    expect(kept.length).toBeLessThanOrEqual(20);
    expect(kept.reduce((n, h) => n + h.text.length, 0)).toBeLessThanOrEqual(4000);
    expect(kept.at(-1)!.text.startsWith("note 29 ")).toBe(true);
    expect(kept[0]!.text.startsWith(`note ${30 - kept.length} `)).toBe(true);
  });

  it("instructions carry LUME's rules for each task", () => {
    for (const task of ["next_step", "catch_up"] as const) {
      const text = instructionsFor(task);
      expect(text).toMatch(/only the facts/i);
      expect(text).toMatch(/never invent/i);
    }
    expect(instructionsFor("next_step")).toMatch(/ids only from the lists/i);
  });

  it("the next step's shape is strict: no extra keys, a summary of at most 140 characters", () => {
    expect(nextStepOutput.safeParse(step()).success).toBe(true);
    expect(nextStepOutput.safeParse({ ...step(), extra: 1 }).success).toBe(false);
    expect(nextStepOutput.safeParse(step({ summary: "x".repeat(141) })).success).toBe(false);
    expect(nextStepOutput.safeParse(step({ tagIds: ["a", "b", "c", "d"] })).success).toBe(false);
  });

  it("a catch-up is exactly three lines of at most 160 characters", () => {
    expect(catchUpOutput.safeParse({ lines: ["a", "b", "c"] }).success).toBe(true);
    expect(catchUpOutput.safeParse({ lines: ["a", "b"] }).success).toBe(false);
    expect(catchUpOutput.safeParse({ lines: ["a", "b", "x".repeat(161)] }).success).toBe(false);
  });
});
