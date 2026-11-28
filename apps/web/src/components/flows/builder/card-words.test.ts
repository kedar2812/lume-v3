import { describe, expect, it } from "vitest";
import type { GNode } from "@lume/core/shared";
import { exitsOfNode } from "./graph-edit";
import { exitWords, headline } from "./kinds";

/**
 * What a step's card says (owner 2026-11-28: "the information is not easily understood"): each way out as what the
 * person does to take it, and a second line under the kind only when the card doesn't already show it below.
 */
const words = (n: GNode) => exitsOfNode(n).map((e) => exitWords(n, e));

const MSG: GNode = {
  id: "m",
  type: "message",
  text: "Want the guide?",
  buttons: [],
  replies: [
    { id: "y", title: "Yes please", next: "q" },
    { id: "n", title: "Not now", next: null },
  ],
  next: null,
};

describe("a card's ways out, in words", () => {
  it("a message's quick replies are what they tap; anything else is what they say instead", () => {
    expect(words(MSG)).toEqual(["Taps “Yes please”", "Taps “Not now”", "Replies anything else"]);
  });

  it("a message with no routed replies just goes on", () => {
    expect(words({ ...MSG, replies: [] })).toEqual(["Then"]);
    expect(words({ ...MSG, replies: [{ id: "y", title: "Yes", next: null }] })).toEqual([
      "Taps “Yes”",
      "Then",
    ]);
  });

  it("a reply with no title yet still reads", () => {
    expect(words({ ...MSG, replies: [{ id: "y", title: "", next: "q" }] })[0]).toBe("Taps a reply");
  });

  it("a question: the choice they pick, an answer, or no answer in its time", () => {
    const ask: GNode = {
      id: "a",
      type: "ask",
      text: "Which plan?",
      save: { field: "plan", kind: "choice" },
      choices: [{ id: "g", title: "Gold", next: null }],
      retry: "Again?",
      next: null,
      noAnswer: { afterMinutes: 60, next: null },
    } as GNode;
    expect(words(ask)).toEqual(["Picks “Gold”", "Answers", "No answer in 1 hour"]);
  });

  it("a check is if yes or if no; a split test's paths are their share of people", () => {
    expect(words({ id: "c", type: "check", match: "all", rules: [], yes: null, no: null })).toEqual([
      "If yes",
      "If no",
    ]);
    expect(
      words({
        id: "s",
        type: "split",
        paths: [
          { id: "a", weight: 70, next: null },
          { id: "b", weight: 30, next: null },
        ],
      }),
    ).toEqual(["70% of people", "30% of people"]);
  });

  it("a wait, a change to the lead, telling the team and a booking link go on with Then", () => {
    expect(words({ id: "w", type: "wait", for: { minutes: 60 }, next: null })).toEqual(["Then"]);
    expect(words({ id: "u", type: "update", actions: [], next: null })).toEqual(["Then"]);
    expect(words({ id: "t", type: "notify", to: "owner", text: "", next: null } as GNode)).toEqual(["Then"]);
    expect(words({ id: "b", type: "book", text: "", next: null } as GNode)).toEqual(["Then"]);
  });
});

describe("a card's second line", () => {
  it("never repeats what the card shows below it (a message's words, a wait's time)", () => {
    expect(headline(MSG)).toBeNull();
    expect(headline({ id: "w", type: "wait", for: { minutes: 60 }, next: null })).toBeNull();
    expect(headline({ id: "h", type: "handoff", to: "person" } as GNode)).toBeNull();
  });

  it("says what a step without a body does", () => {
    expect(headline({ id: "c", type: "check", match: "all", rules: [], yes: null, no: null })).toBe(
      "Choose what to check",
    );
    expect(headline({ id: "u", type: "update", actions: [], next: null })).toBe("Choose what changes");
  });
});
