import { describe, expect, it } from "vitest";
import { instagramWindow } from "../instagram/window";
import { handoverWords, nextMoveInstagram } from "./autopilot";

/** LUME AI on Instagram (plan 2026-11-27-instagram-lume-ai Task 1): it only ever answers, inside Instagram's window. */
const NOW = new Date("2026-11-27T10:00:00Z");
const H = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const lead = (o: Partial<Parameters<typeof nextMoveInstagram>[0]> = {}) => ({
  state: "replied" as const,
  lastSentAt: null,
  lastInboundAt: ago(H),
  ...o,
});
const win = (lastInAt: Date | null, adWindowUntil: Date | null = null) =>
  instagramWindow({ lastInAt, adWindowUntil }, NOW);

describe("what LUME AI does next with an Instagram lead", () => {
  it("answers a message waiting for an answer, while Instagram's 24 hours are open", () => {
    expect(nextMoveInstagram(lead(), win(ago(H)))).toEqual({ kind: "reply" });
    expect(nextMoveInstagram(lead({ state: "talking", lastSentAt: ago(2 * H) }), win(ago(H)))).toEqual({
      kind: "reply",
    });
  });

  it("nothing waiting: it waits for them to write, never a first message or a follow-up", () => {
    expect(nextMoveInstagram(lead({ state: "sent", lastSentAt: ago(H / 2) }), win(ago(H)))).toEqual({
      kind: "wait",
    });
    expect(
      nextMoveInstagram(
        lead({ state: "up_next", lastInboundAt: ago(H), lastSentAt: ago(H / 2) }),
        win(ago(H)),
      ),
    ).toEqual({ kind: "wait" });
  });

  it("the 24 hours ended with their message unanswered: a person, and until when a person still can", () => {
    const m = nextMoveInstagram(lead({ lastInboundAt: ago(25 * H) }), win(ago(25 * H)));
    expect(m).toEqual({ kind: "handover", until: new Date(ago(25 * H).getTime() + 7 * 24 * H) });
  });

  it("past the 7 days too: a person, with no time left to say", () => {
    expect(nextMoveInstagram(lead({ lastInboundAt: ago(8 * 24 * H) }), win(ago(8 * 24 * H)))).toEqual({
      kind: "handover",
      until: null,
    });
  });

  it("they never wrote (nothing to answer): a person, never a first message from LUME AI", () => {
    // Handed over after a flow's own message (a comment flow, nothing from them yet): it waits for them.
    expect(nextMoveInstagram(lead({ lastInboundAt: null, state: "talking" }), win(null))).toEqual({
      kind: "wait",
    });
    expect(nextMoveInstagram(lead({ lastInboundAt: null, state: "up_next" }), win(null))).toEqual({
      kind: "handover",
      until: null,
    });
  });

  it("an ad's 7 days: still answering on day 3", () => {
    const first = ago(3 * 24 * H);
    expect(
      nextMoveInstagram(lead({ lastInboundAt: first }), win(first, new Date(first.getTime() + 7 * 24 * H))),
    ).toEqual({ kind: "reply" });
  });

  it("writing, or with a person: left alone", () => {
    for (const state of ["writing", "ready", "needs_you", "with_you", "stopped", "skipped"] as const)
      expect(nextMoveInstagram(lead({ state }), win(ago(H)))).toEqual({ kind: "wait" });
  });

  it("the handover's words name the day and time a person can still answer, in the business's zone", () => {
    expect(handoverWords(new Date("2026-11-30T10:51:00Z"), "Asia/Kolkata")).toBe(
      "Instagram's 24 hours ran out. A person can still answer until Monday, November 30, 4:21 pm.",
    );
    expect(handoverWords(null, "Asia/Kolkata")).toBe(
      "Instagram's time to answer ran out. They can write again.",
    );
  });
});
