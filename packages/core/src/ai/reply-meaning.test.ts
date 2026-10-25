import { describe, expect, it } from "vitest";
import {
  REPLY_MEANINGS,
  REPLY_MEANING_WORDS,
  cleanReplyMeaning,
  replyMeaningInput,
  replyMeaningInstructions,
  replyMeaningOutput,
  type ReplyMeaning,
} from "./reply-meaning";
import type { LeadFacts } from "./tasks";

/** What a WhatsApp reply means (W2, spec 2026-10-18 §4.2, §5.1, §5.4). */
const facts: LeadFacts = {
  firstName: "Sneha",
  stage: { id: "s-new", name: "New enquiry" },
  stages: [
    { id: "s-new", name: "New enquiry", kind: "open" },
    { id: "s-visit", name: "Site visit booked", kind: "open" },
    { id: "s-won", name: "Won", kind: "won" },
    { id: "s-lost", name: "Lost", kind: "lost" },
  ],
  lostReasons: [{ id: "r-price", label: "Too expensive" }],
  tags: [],
  fields: [],
  history: [],
  timezone: "Asia/Kolkata",
  now: "2026-10-21T06:00:00.000Z",
};
const answer = (o: Partial<ReplyMeaning> = {}): ReplyMeaning =>
  replyMeaningOutput.parse({
    meaning: "interested",
    summary: "Wants a site visit on Saturday.",
    stop: false,
    stageId: null,
    followUp: null,
    lostReasonId: null,
    ...o,
  });

describe("the groups", () => {
  it("in the board's order, each in the words people read", () => {
    expect([...REPLY_MEANINGS]).toEqual([
      "interested",
      "price",
      "visit_or_call",
      "later",
      "not_interested",
      "stop",
      "wrong_number",
      "not_sure",
    ]);
    expect(REPLY_MEANINGS.map((m) => REPLY_MEANING_WORDS[m])).toEqual([
      "Interested",
      "Asked the price",
      "Wants a visit or call",
      "Later",
      "Not interested",
      "Stop messaging",
      "Wrong number",
      "Not sure",
    ]);
  });
});

describe("what LUME AI is asked", () => {
  it("the reply, the recent thread and the lead's facts; never a phone or an email", () => {
    const input = replyMeaningInput(
      facts,
      [
        {
          from: "business",
          at: "2026-10-21T05:00:00.000Z",
          text: "Hi Sneha, would you like a free site visit?",
        },
        { from: "lead", at: "2026-10-21T05:59:00.000Z", text: "Saturday 11 works" },
      ],
      "Saturday 11 works",
    );
    expect(input).toContain('"task":"reply_meaning"');
    expect(input).toContain("would you like a free site visit?");
    expect(input).toContain("The reply:\nSaturday 11 works");
    expect(input).not.toMatch(/@|\+\d{6,}/);
    const say = replyMeaningInstructions;
    for (const words of ["Interested", "Stop messaging", "never invent", "stop: true"])
      expect(say).toContain(words);
  });
});

describe("what the business can use of the answer", () => {
  it("ids only from its own lists; a lost reason only with a lost stage; a follow-up only after now", () => {
    expect(cleanReplyMeaning(answer({ stageId: "s-made-up" }), facts).stageId).toBeNull();
    expect(cleanReplyMeaning(answer({ stageId: "s-visit" }), facts).stageId).toBe("s-visit");
    expect(
      cleanReplyMeaning(answer({ stageId: "s-visit", lostReasonId: "r-price" }), facts).lostReasonId,
    ).toBeNull();
    expect(
      cleanReplyMeaning(
        answer({ meaning: "not_interested", stageId: "s-lost", lostReasonId: "r-price" }),
        facts,
      ),
    ).toMatchObject({ stageId: "s-lost", lostReasonId: "r-price" });
    expect(
      cleanReplyMeaning(answer({ followUp: { at: "2026-10-20T11:00", title: "Call" } }), facts).followUp,
    ).toBeNull();
    expect(
      cleanReplyMeaning(answer({ followUp: { at: "2026-10-24T11:00", title: "Site visit" } }), facts)
        .followUp,
    ).toEqual({ at: "2026-10-24T11:00", title: "Site visit" });
  });

  it("a stop is a stop whichever way it's said: the group, the flag, and nothing else suggested", () => {
    const heard = cleanReplyMeaning(
      answer({
        meaning: "later",
        stop: true,
        stageId: "s-visit",
        followUp: { at: "2026-10-24T11:00", title: "x" },
      }),
      facts,
    );
    expect(heard).toMatchObject({
      meaning: "stop",
      stop: true,
      stageId: null,
      followUp: null,
      lostReasonId: null,
    });
    expect(cleanReplyMeaning(answer({ meaning: "stop" }), facts).stop).toBe(true);
  });
});
