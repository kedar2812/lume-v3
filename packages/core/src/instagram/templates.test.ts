import { describe, expect, it } from "vitest";
import { NEW_RUN, type FlowCtx, type RunState } from "./flows";
import {
  FILL_IN,
  GRAPH_LIMITS,
  blocking,
  flowGraphSchema,
  validateGraph,
  type FlowGraph,
  type GNode,
} from "./graph";
import { stepGraph } from "./graph-run";
import { IG_LIMITS, textBytes } from "./limits";
import { READY_FLOWS, READY_GROUPS, READY_KEYS, readyFlow, readyTags, withTags } from "./templates";

/** The ready-made flows (plan 2026-11-25-instagram-screens D4; plan 2026-11-23-flow-builder D7). */
const now = new Date("2026-11-25T06:00:00Z");
const open = { state: "open" as const, until: new Date(now.getTime() + 86_400_000) };
const ctx = (o: Partial<FlowCtx> = {}): FlowCtx => ({
  now,
  window: open,
  privateReplyOnly: false,
  lead: { tags: [], fields: {} },
  personWords: ["PERSON"],
  tz: "Asia/Kolkata",
  seed: "run-1",
  ...o,
});
const ok = { ai: false };
/** What a business would write: every [[…]] written, every link added, every tag chosen. */
function filled(gr: FlowGraph): FlowGraph {
  let i = 0;
  const words = (t: string) => t.replace(new RegExp(FILL_IN.source, "g"), () => `Ours ${++i}`);
  const tags = Object.fromEntries(readyTags(gr).map((t) => [t, `tag-${t}`]));
  const g2 = withTags(gr, tags);
  return {
    ...g2,
    nodes: g2.nodes.map((n): GNode => {
      if (n.type === "message")
        return {
          ...n,
          text: words(n.text),
          buttons: n.buttons.map((b) => ({
            ...b,
            title: words(b.title),
            url: b.url || "https://example.test/x",
          })),
          replies: n.replies.map((r) => ({ ...r, title: words(r.title) })),
        };
      if (n.type === "ask")
        return {
          ...n,
          text: words(n.text),
          choices: n.choices?.map((c) => ({ ...c, title: words(c.title) })),
        };
      if (n.type === "book") return { ...n, text: words(n.text), url: n.url || "https://example.test/book" };
      return n;
    }),
  };
}

describe("the ready-made flows", () => {
  it("fifteen, each in a group, with a name, what it does, what starts it and its steps in words", () => {
    expect(READY_KEYS).toHaveLength(15);
    const groups = new Set(READY_GROUPS.map((x) => x.id));
    for (const key of READY_KEYS) {
      const f = readyFlow(key);
      expect(groups.has(f.group), key).toBe(true);
      for (const t of [f.name, f.what, f.why, f.starts, f.fill]) expect(t.trim(), key).not.toBe("");
      expect(f.preview.length, key).toBeGreaterThan(0);
      // LUME's words: no em dashes, no "we" telling the business what LUME does.
      for (const t of [f.name, f.what, f.why, f.starts, f.fill, ...f.preview.flat()])
        expect(t, key).not.toMatch(/—/);
    }
    // Every group has at least one.
    for (const g of READY_GROUPS)
      expect(
        READY_KEYS.some((k) => READY_FLOWS[k].group === g.id),
        g.id,
      ).toBe(true);
  });

  it("each is a graph the API takes, inside LUME's and Meta's limits", () => {
    for (const key of READY_KEYS) {
      const g = filled(readyFlow(key).graph());
      expect(flowGraphSchema.safeParse(g).success, key).toBe(true);
      expect(g.nodes.length, key).toBeLessThanOrEqual(GRAPH_LIMITS.nodes);
      expect(JSON.stringify(g).length, key).toBeLessThan(GRAPH_LIMITS.bytes);
      for (const n of g.nodes) {
        if (n.type === "message") {
          expect(textBytes(n.text), key).toBeLessThanOrEqual(IG_LIMITS.textBytes);
          expect(n.replies.length, key).toBeLessThanOrEqual(IG_LIMITS.quickReplies);
          for (const r of n.replies)
            expect([...r.title].length, key).toBeLessThanOrEqual(IG_LIMITS.quickReplyChars);
          for (const b of n.buttons)
            expect([...b.title].length, key).toBeLessThanOrEqual(IG_LIMITS.buttonTitleChars);
        }
        if (n.type === "ask")
          for (const c of n.choices ?? [])
            expect([...c.title].length, key).toBeLessThanOrEqual(IG_LIMITS.quickReplyChars);
      }
    }
  });

  it("can't go live until what only the business knows is filled in; then nothing stops it", () => {
    const ready = new Set(["story_reply", "story_mention", "ad_greeting", "welcome", "waitlist"]);
    for (const key of READY_KEYS) {
      const raw = withTags(
        readyFlow(key).graph(),
        Object.fromEntries(readyTags(readyFlow(key).graph()).map((t) => [t, `tag-${t}`])),
      );
      const before = blocking(validateGraph(raw, ok));
      if (ready.has(key)) expect(before, key).toEqual([]);
      else expect(before.length, key).toBeGreaterThan(0);
      expect(blocking(validateGraph(filled(readyFlow(key).graph()), ok)), key).toEqual([]);
    }
  });

  it("a tag it names is the business's own once found; one LUME couldn't find is left to choose", () => {
    const g = readyFlow("comment_freebie").graph();
    expect(readyTags(g)).toEqual(["guide"]);
    const found = withTags(g, { guide: "t-1" });
    const tagOf = (x: FlowGraph) =>
      x.nodes.flatMap((n) => (n.type === "update" ? n.actions : [])).find((a) => a.kind === "tag");
    expect(tagOf(found)).toMatchObject({ tagId: "t-1" });
    const none = withTags(g, {});
    expect(tagOf(none)).toMatchObject({ tagId: "" });
    expect(validateGraph(none, ok).map((p) => p.words)).toContain("Choose the tag.");
  });

  it("each runs end to end on what starts it, and ends (never loops, never more than Meta allows)", () => {
    const answers: Record<string, string> = {
      email: "priya@example.test",
      story_interest: "The lunch box",
      interest: "Prices",
      start: "This week",
      readiness: "Ready to go",
      rating: "5",
      question: "Hours",
      service: "Ours 1",
    };
    for (const key of READY_KEYS) {
      const f = readyFlow(key);
      const g = filled(f.graph());
      const comment = f.trigger.kind === "comment";
      let state: RunState = NEW_RUN;
      let t = stepGraph(
        g,
        state,
        { kind: "start", via: comment ? "comment" : "dm" },
        ctx({ privateReplyOnly: comment }),
      );
      let sent = t.actions.filter((a) => a.kind === "send").length;
      // A comment's flow: its first message is the one private reply.
      if (comment)
        expect(
          t.actions.find((a) => a.kind === "send"),
          key,
        ).toMatchObject({ asPrivateReply: true });
      let at = now;
      for (let turn = 0; !t.done && turn < 12; turn++) {
        state = t.state;
        const w = state.waiting;
        if (w?.for === "until") {
          at = new Date(Date.parse(w.until) + 1000);
          t = stepGraph(g, state, { kind: "timer", now: at }, ctx({ now: at }));
        } else {
          // Tap the first reply, or answer the question as a person would.
          const n = g.nodes.find(
            (x) => x.id === (w && "nodeId" in w ? w.nodeId : w && "stepId" in w ? w.stepId : ""),
          );
          const text =
            n?.type === "message"
              ? n.replies[0]!.title
              : n?.type === "ask"
                ? (n.choices?.find((c) => c.title === answers[n.save.field])?.title ??
                  n.choices?.[0]?.title ??
                  answers[n.save.field] ??
                  "Yes")
                : "Thanks";
          t = stepGraph(g, state, { kind: "message", text }, ctx());
        }
        sent += t.actions.filter((a) => a.kind === "send").length;
      }
      expect(t.done, key).toBeTruthy();
      expect(["finished", "handed"], `${key}: ${t.done?.reason}`).toContain(t.done!.reason);
      expect(sent, key).toBeGreaterThan(0);
      expect(sent, key).toBeLessThanOrEqual(GRAPH_LIMITS.sends);
    }
  });

  it("nothing waits past Instagram's 24 hours, so every step it shows can really happen", () => {
    for (const key of READY_KEYS)
      for (const n of readyFlow(key).graph().nodes)
        if (n.type === "wait" && "minutes" in n.for) expect(n.for.minutes, key).toBeLessThan(24 * 60);
  });

  it("a fresh graph each time: changing one flow's copy never changes the next", () => {
    const a = readyFlow("welcome").graph();
    (a.nodes[0] as { text: string }).text = "changed";
    expect((readyFlow("welcome").graph().nodes[0] as { text: string }).text).not.toBe("changed");
  });
});
