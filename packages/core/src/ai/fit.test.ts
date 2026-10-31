import { describe, expect, it } from "vitest";
import { z } from "zod";
import { autopilotFirstOutput, autopilotReplyOutput } from "./autopilot-tasks";
import { clipText, fitAnswer } from "./fit";
import { replyMeaningInstructions, replyMeaningOutput } from "./reply-meaning";
import { catchUpOutput, instructionsFor, nextStepOutput } from "./tasks";

/**
 * An answer whose explanation runs a few characters past its limit is still read (eval 2026-10-31: 24 of Haiku 5.5's
 * 165 answers were thrown away whole, "Too big: expected string to have <=140 characters"). Only the words a person
 * reads about the answer are shortened; what is sent to a lead or written on a lead never is.
 */
const long = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const parses = <T>(schema: z.ZodType<T>, v: unknown) => schema.safeParse(fitAnswer(schema, v));

describe("clipText", () => {
  it("cuts at a word boundary and ends with an ellipsis, within the limit", () => {
    const out = clipText("Asked for the 3D design first and a quote by Friday", 30);
    expect(out).toBe("Asked for the 3D design first…");
    expect(out.length).toBeLessThanOrEqual(30);
  });
  it("cuts a single long word hard when there is no space to break at", () => {
    const out = clipText("x".repeat(50), 20);
    expect(out).toBe(`${"x".repeat(19)}…`);
  });
  it("leaves text within the limit alone, and never splits a surrogate pair", () => {
    expect(clipText("short", 10)).toBe("short");
    const out = clipText(`${"a".repeat(8)}😀😀`, 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(/[\uD800-\uDBFF]…$/.test(out)).toBe(false);
  });
});

describe("fitAnswer", () => {
  const nextStep = {
    summary: long(40),
    stageId: null,
    followUp: { at: "2026-10-20T10:00", title: long(20) },
    lostReasonId: null,
    tagIds: [],
    decisionMaker: long(15),
  };

  it("shortens a next step's summary, follow-up title and decision maker, so the answer is read", () => {
    expect(nextStepOutput.safeParse(nextStep).success).toBe(false);
    const r = parses(nextStepOutput, nextStep);
    expect(r.success).toBe(true);
    expect(r.data!.summary.length).toBeLessThanOrEqual(140);
    expect(r.data!.summary.endsWith("…")).toBe(true);
    expect(r.data!.followUp!.title.length).toBeLessThanOrEqual(80);
    expect(r.data!.decisionMaker!.length).toBeLessThanOrEqual(60);
  });

  it("leaves a null where a null was given", () => {
    const r = parses(nextStepOutput, { ...nextStep, followUp: null, decisionMaker: null });
    expect(r.success).toBe(true);
    expect(r.data!.followUp).toBeNull();
    expect(r.data!.decisionMaker).toBeNull();
  });

  it("shortens a reply meaning's summary and an Autopilot first message's why", () => {
    const meaning = {
      meaning: "price",
      summary: long(40),
      stop: false,
      stageId: null,
      followUp: null,
      lostReasonId: null,
    };
    expect(parses(replyMeaningOutput, meaning).success).toBe(true);
    const first = { templateId: "0190f3c2-7d4e-7a1b-8c3d-1e2f3a4b5c6d", why: long(60) };
    expect(parses(autopilotFirstOutput, first).success).toBe(true);
  });

  const reply = {
    kind: "reply",
    message: "Hi Meera, a visit is free.",
    reason: long(60),
    evidence: long(80),
    fileIds: [],
    stageId: null,
    fields: [],
    followUp: null,
    lostReasonId: null,
  };

  it("shortens an Autopilot reply's reason and evidence", () => {
    const r = parses(autopilotReplyOutput, reply);
    expect(r.success).toBe(true);
    expect(r.data!.reason.length).toBeLessThanOrEqual(200);
    expect(r.data!.evidence!.length).toBeLessThanOrEqual(300);
  });

  it("never shortens the message to the lead: a message over its limit is still not read", () => {
    const r = parses(autopilotReplyOutput, { ...reply, reason: "ok", evidence: null, message: long(300) });
    expect(r.success).toBe(false);
  });

  it("never shortens a value written on the lead: a field value over its limit is still not read", () => {
    const r = parses(autopilotReplyOutput, {
      ...reply,
      reason: "ok",
      evidence: null,
      fields: [{ key: "address", value: long(60) }],
    });
    expect(r.success).toBe(false);
  });

  it("does not touch anything that isn't text, or text where a list or object belongs", () => {
    expect(fitAnswer(nextStepOutput, null)).toBeNull();
    expect(fitAnswer(nextStepOutput, "nope")).toBe("nope");
    const odd = { ...nextStep, summary: 42 };
    expect(parses(nextStepOutput, odd).success).toBe(false);
  });

  it("does not change the answer it was given", () => {
    const given = structuredClone(nextStep);
    fitAnswer(nextStepOutput, given);
    expect(given).toEqual(nextStep);
  });
});

describe("the instructions say the limits", () => {
  // The schema a provider is sent carries no lengths (not every provider takes them), so the words must.
  it("names each explanation's limit to the model", () => {
    expect(instructionsFor("next_step")).toMatch(/summary: .*at most 140 characters/);
    expect(instructionsFor("catch_up")).toMatch(/two or three lines/i);
    expect(replyMeaningInstructions).toMatch(/summary: .*at most 140 characters/);
  });
});

describe("catch-up lines", () => {
  it("takes two or three lines (a short history has less to say), never one or four", () => {
    expect(catchUpOutput.safeParse({ lines: ["Who and what.", "Where it stands."] }).success).toBe(true);
    expect(catchUpOutput.safeParse({ lines: ["a", "b", "c"] }).success).toBe(true);
    expect(catchUpOutput.safeParse({ lines: ["a"] }).success).toBe(false);
    expect(catchUpOutput.safeParse({ lines: ["a", "b", "c", "d"] }).success).toBe(false);
  });
  it("shortens a line past 160 characters", () => {
    const r = parses(catchUpOutput, { lines: [long(40), "b", "c"] });
    expect(r.success).toBe(true);
    expect(r.data!.lines[0]!.length).toBeLessThanOrEqual(160);
  });
});
