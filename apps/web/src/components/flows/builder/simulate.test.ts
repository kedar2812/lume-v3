import { describe, expect, it } from "vitest";
import type { FlowGraph, GNode } from "@lume/core/shared";
import { begin, say, skip } from "./simulate";

/** The phone test's engine (plan 2026-11-23-flow-builder, Task B3): LUME's own interpreter, in the browser. */
const msg = (id: string, o: Partial<Extract<GNode, { type: "message" }>> = {}): GNode => ({
  id,
  type: "message",
  text: `Say ${id}`,
  buttons: [],
  replies: [],
  next: null,
  ...o,
});
const g = (start: string, ...nodes: GNode[]): FlowGraph => ({ v: 2, start, nodes, pos: {}, notes: [] });

describe("the phone test", () => {
  it("the first message comes in with its quick replies; a tap goes down that line and lights its steps", () => {
    const flow = g(
      "hi",
      msg("hi", {
        replies: [
          { id: "y", title: "Yes", next: "yes" },
          { id: "n", title: "No", next: "no" },
        ],
      }),
      msg("yes"),
      msg("no"),
    );
    const a = begin(flow, "t1");
    expect(a.lines.map((l) => [l.from, l.text])).toEqual([["business", "Say hi"]]);
    expect(a.replies.map((r) => r.title)).toEqual(["Yes", "No"]);
    expect(a.now).toBe("reply");
    const b = say(a, flow, "t1", "Yes", "qr:hi:y");
    expect(b.lines.map((l) => [l.from, l.text])).toEqual([
      ["business", "Say hi"],
      ["person", "Yes"],
      ["business", "Say yes"],
    ]);
    expect(b.replies).toEqual([]);
    expect(b.lit).toEqual(["hi", "yes"]);
    expect(b.now).toBe("done");
  });

  it("a question checks its answer as the live flow does: a wrong one is asked again", () => {
    const flow = g(
      "q",
      {
        id: "q",
        type: "ask",
        text: "Your email?",
        save: { field: "email", kind: "email" },
        retry: "That doesn't look like an email.",
        next: "ok",
        noAnswer: { afterMinutes: 0, next: null },
      },
      msg("ok"),
    );
    const a = begin(flow, "t");
    const wrong = say(a, flow, "t", "not an email");
    expect(wrong.lines.at(-1)).toMatchObject({ from: "business", text: "That doesn't look like an email." });
    const right = say(wrong, flow, "t", "priya@example.test");
    expect(right.lines.slice(-2).map((l) => l.text)).toEqual(["Saves priya@example.test as email", "Say ok"]);
  });

  it("a wait can be skipped; what the flow does to the lead is said, nothing changes", () => {
    const flow = g(
      "w",
      { id: "w", type: "wait", for: { minutes: 60 }, next: "u" },
      { id: "u", type: "update", actions: [{ kind: "tag", tagId: "t-hot", add: true }], next: "h" },
      { id: "h", type: "handoff", to: "person" },
    );
    const a = begin(flow, "t", { tag: (id) => (id === "t-hot" ? "Hot" : id), stage: (id) => id });
    expect(a.now).toBe("wait");
    expect(a.until).not.toBeNull();
    const b = skip(a, flow, "t", { tag: (id) => (id === "t-hot" ? "Hot" : id), stage: (id) => id });
    expect(b.lines.map((l) => l.text)).toEqual([
      "Tags the lead Hot",
      "A person on your team takes the conversation",
    ]);
    expect(b.now).toBe("handed");
  });

  it("once the run has ended, words and Skip change nothing; a step gone through twice lights once", () => {
    const flow = g(
      "hi",
      msg("hi", {
        replies: [
          { id: "a", title: "Again", next: "hi" },
          { id: "e", title: "End", next: "bye" },
        ],
      }),
      msg("bye"),
    );
    const a = begin(flow, "t");
    const b = say(a, flow, "t", "Again", "qr:hi:a");
    expect(b.lines.filter((l) => l.text === "Say hi")).toHaveLength(2);
    expect(b.lit).toEqual(["hi"]);
    expect(b.replies.map((r) => r.title)).toEqual(["Again", "End"]);
    const c = say(b, flow, "t", "End", "qr:hi:e");
    expect(c.ended).not.toBeNull();
    expect(c.replies).toEqual([]);
    expect(say(c, flow, "t", "hello?")).toBe(c);
    expect(skip(c, flow, "t")).toBe(c);
  });

  it("started by a comment: one private reply goes, the rest when they write back (as live)", () => {
    const flow = g("a", msg("a", { next: "b" }), msg("b"));
    const a = begin(flow, "t", undefined, new Date(), "comment");
    expect(a.lines.filter((l) => l.from === "business").map((l) => l.text)).toEqual(["Say a"]);
    expect(a.now).toBe("message");
    const b = say(a, flow, "t", "thanks!");
    expect(b.lines.filter((l) => l.from === "business").map((l) => l.text)).toEqual(["Say a", "Say b"]);
    // Started by a message, both go at once.
    expect(begin(flow, "t").lines.map((l) => l.text)).toEqual(["Say a", "Say b"]);
  });

  it("Meta's 24 hours run from their last message: a wait past them ends it, as it would live", () => {
    const at = new Date("2026-11-24T10:00:00Z");
    const long = g("w", { id: "w", type: "wait", for: { minutes: 25 * 60 }, next: "m" }, msg("m"));
    expect(begin(long, "t", undefined, at).ended).toBe(
      "Instagram's time to reply would run out during this wait.",
    );
    const short = g("w", { id: "w", type: "wait", for: { minutes: 23 * 60 }, next: "m" }, msg("m"));
    const a = begin(short, "t", undefined, at);
    expect(a.now).toBe("wait");
    expect(skip(a, short, "t").lines.map((l) => l.text)).toEqual(["Say m"]);
  });

  it("a file in a message is said in words, with its text", () => {
    const flow = g("a", msg("a", { text: "Your guide", media: { kind: "file", fileId: "f-1" } }));
    expect(begin(flow, "t").lines[0]!.text).toBe("[A file]\nYour guide");
  });

  it("a comment isn't a message: a wait after the private reply ends it, as live (review 2026-11-24)", () => {
    const flow = g(
      "a",
      msg("a", { next: "w" }),
      { id: "w", type: "wait", for: { minutes: 10 }, next: "b" },
      msg("b"),
    );
    const a = begin(flow, "t", undefined, new Date(), "comment");
    // The private reply has gone; the wait is reached only once they write, and then their 24 hours are open.
    const b = say(a, flow, "t", "hi");
    expect(b.now).toBe("wait");
    expect(skip(b, flow, "t").lines.at(-1)!.text).toBe("Say b");
    // A flow that waits first: live, Meta's time isn't open for a comment, so it ends there.
    const first = g("w", { id: "w", type: "wait", for: { minutes: 10 }, next: "b" }, msg("b"));
    expect(begin(first, "t", undefined, new Date(), "comment").ended).toBe(
      "Instagram's time to reply would run out during this wait.",
    );
  });

  it("a question a comment started: no second private reply when its time runs out", () => {
    const flow = g(
      "q",
      {
        id: "q",
        type: "ask",
        text: "Your email?",
        save: { field: "email", kind: "email" },
        retry: "Try again.",
        next: null,
        noAnswer: { afterMinutes: 30, next: "m" },
      },
      msg("m"),
    );
    const a = begin(flow, "t", undefined, new Date(), "comment");
    expect(a.now).toBe("answer");
    const b = skip(a, flow, "t");
    expect(b.lines.filter((l) => l.text === "Say m")).toEqual([]);
    expect(b.ended).toBe("Instagram's time to reply ran out before this step.");
  });
});
