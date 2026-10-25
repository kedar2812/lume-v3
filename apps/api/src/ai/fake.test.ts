import { autopilotReplyOutput } from "@lume/core";
import { describe, expect, it } from "vitest";
import { fakeProvider } from "./fake";

/** The fake LUME AI's own answers in a run (Autopilot A3): the lead's latest words choose them, for end-to-end runs. */
const read = async (said: string) => {
  const input = JSON.stringify({
    task: "autopilot_reply",
    thread: [
      { from: "business", at: "2026-10-26T08:00:00.000Z", text: "Hi, thanks for your enquiry." },
      { from: "lead", at: "2026-10-26T08:05:00.000Z", text: said },
    ],
  });
  const r = await fakeProvider().read({
    instructions: "",
    input,
    schema: autopilotReplyOutput,
    maxOutputTokens: 100,
    signal: new AbortController().signal,
  } as never);
  return r.output as { kind: string; message: string | null; evidence: string | null };
};

describe("the fake provider's run answers", () => {
  it("a yes reaches the goal, with the lead's words as evidence", async () => {
    expect(await read("Saturday works for me")).toMatchObject({
      kind: "converted",
      message: null,
      evidence: "Saturday works for me",
    });
  });

  it("a price question goes to a person", async () => {
    expect(await read("What do you charge for a kitchen?")).toMatchObject({
      kind: "handover",
      message: null,
    });
  });

  it("photos get a longer answer, long enough to pause or take over while it's typed", async () => {
    const r = await read("Do you have photos of past work?");
    expect(r.kind).toBe("reply");
    expect(r.message!.length).toBeGreaterThan(200);
  });

  it("anything else gets the plain reply", async () => {
    expect(await read("Hello, is this the studio?")).toMatchObject({
      kind: "reply",
      message: "Thanks for your message! Happy to help.",
    });
  });
});
