"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FlowGraph } from "@lume/core/shared";
import type { Catalog } from "@/lib/leads/types";
import { PanelHead, type Tool } from "./PanelHead";
import { begin, say, skip, type Names, type Sim } from "./simulate";
import s from "./test.module.css";
import b from "./builder.module.css";

const PHONE_H = 654;
/** How a test ended, in words; the engine's own sentences (Meta's window, a flow changed) are said as they are. */
const ENDED: Record<string, string> = {
  finished: "The flow has ended.",
  "no answer": "No answer came, so the flow has ended.",
  "went to another flow": "It goes on to another flow here. The test ends.",
};

/**
 * Test (plan 2026-11-23-flow-builder, Task B3; canvas board BuilderTest): the draft on an iPhone, as it reads on
 * Instagram. LUME's own interpreter runs it here: the person's side is typed or tapped, a wait can be skipped, and what
 * the flow would do to the lead is said in the chat. Nothing is sent and no lead changes.
 */
export function TestPanel({
  graph,
  businessName,
  catalog,
  byComment,
  onLit,
  onTool,
  onClose,
}: {
  graph: FlowGraph;
  businessName: string;
  catalog: Catalog;
  /** A comment is one of the flow's ways in: the test can start that way too. */
  byComment: boolean;
  onLit: (ids: string[]) => void;
  onTool: (t: Tool) => void;
  onClose: () => void;
}) {
  const names: Names = {
    tag: (id) => catalog.tags.find((t) => t.id === id)?.label ?? "a tag",
    stage: (id) => catalog.pipelines.flatMap((p) => p.stages).find((st) => st.id === id)?.name ?? "a stage",
  };
  const [via, setVia] = useState<"dm" | "comment">("dm");
  const [seed, setSeed] = useState(() => Math.random().toString(36).slice(2));
  const [sim, setSim] = useState<Sim>(() => begin(graph, seed, names, new Date(), via));
  const [draft, setDraft] = useState("");
  const thread = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => onLit(sim.lit), [sim.lit, onLit]);
  useEffect(() => () => onLit([]), [onLit]);
  useEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight });
  }, [sim.lines.length]);
  // The phone fits the panel's height whole: smaller, never cut off.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(Math.max(0.5, Math.min(1, el.clientHeight / PHONE_H)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const again = (v = via) => {
    const next = Math.random().toString(36).slice(2);
    setVia(v);
    setSeed(next);
    setSim(begin(graph, next, names, new Date(), v));
    setDraft("");
  };
  // The steps changed while testing: the test starts again on what's drawn now, never on steps that are gone. A card
  // moved changes only where it sits, so the test goes on (review 2026-11-24).
  const [ran, setRan] = useState({ nodes: graph.nodes, start: graph.start });
  if (ran.nodes !== graph.nodes || ran.start !== graph.start) {
    setRan({ nodes: graph.nodes, start: graph.start });
    again();
  }
  if (!byComment && via === "comment") again("dm");
  const send = (text: string, payload?: string) => {
    if (!text.trim()) return;
    setSim((x) => say(x, graph, seed, text.trim(), payload, names));
    setDraft("");
  };
  const initials = businessName
    .split(/\s+/)
    .map((w) => Array.from(w)[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const status =
    sim.now === "reply"
      ? "Waiting for a tap on a quick reply."
      : sim.now === "answer"
        ? "Waiting for an answer."
        : sim.now === "wait"
          ? "Waiting before the next step."
          : sim.now === "handed"
            ? "Passed to your team. The flow ends here."
            : sim.now === "done"
              ? (ENDED[sim.ended ?? ""] ?? `The flow has ended. ${sim.ended}`)
              : "Waiting for their next message.";

  return (
    <aside className={`${b.insp} ${s.panel}`} aria-label="Test" data-tool>
      <PanelHead tool="test" onTool={onTool} onClose={onClose} />
      <p className={s.lead}>As it reads on Instagram. Nothing is sent, and no lead changes.</p>
      {byComment && (
        <div className={s.via} role="group" aria-label="Starts with">
          <button type="button" aria-pressed={via === "dm"} onClick={() => again("dm")}>
            A message
          </button>
          <button type="button" aria-pressed={via === "comment"} onClick={() => again("comment")}>
            A comment
          </button>
        </div>
      )}
      <div ref={box} className={s.stage}>
        <div
          className={s.iph}
          style={{ transform: `scale(${scale})` }}
          role="group"
          aria-label="The flow as it reads on Instagram"
        >
          <span className={`${s.btn} ${s.a}`} />
          <span className={`${s.btn} ${s.bb}`} />
          <span className={`${s.btn} ${s.c}`} />
          <span className={`${s.btn} ${s.d}`} />
          <div className={s.screen}>
            <div className={s.status} aria-hidden>
              <span className={s.time}>9:41</span>
              <span className={s.island} />
              <span className={s.bat}>
                <i />
              </span>
            </div>
            <div className={s.head}>
              <span className={s.av}>{initials}</span>
              <span className={s.who}>
                <b>{businessName}</b>
                <span>Instagram</span>
              </span>
            </div>
            <div ref={thread} className={s.thread} role="log" aria-live="polite">
              {sim.lines.map((l) =>
                l.from === "note" ? (
                  <div key={l.key} className={s.note}>
                    {l.text}
                  </div>
                ) : (
                  <div key={l.key} className={s.row} data-out={l.from === "person" || undefined}>
                    <div className={s.bubble}>
                      {l.text}
                      {l.from === "business" &&
                        l.buttons.map((t, i) => (
                          <span key={i} className={s.cardBtn}>
                            {t}
                          </span>
                        ))}
                    </div>
                  </div>
                ),
              )}
            </div>
            {sim.replies.length > 0 && (
              <div className={s.qrs} role="group" aria-label="Quick replies">
                {sim.replies.map((r) => (
                  <button
                    key={r.payload}
                    type="button"
                    className={s.qr}
                    onClick={() => send(r.title, r.payload)}
                  >
                    {r.title}
                  </button>
                ))}
              </div>
            )}
            <form
              className={s.compose}
              onSubmit={(e) => {
                e.preventDefault();
                send(draft);
              }}
            >
              <label className={s.inLabel}>
                <span className={s.sr}>Write as the person</span>
                <input
                  className={s.in}
                  value={draft}
                  disabled={!!sim.ended}
                  placeholder={sim.ended ? "The flow has ended" : "Message..."}
                  onChange={(e) => setDraft(e.target.value)}
                />
              </label>
              {draft.trim() && (
                <button type="submit" className={s.sendBtn}>
                  Send
                </button>
              )}
            </form>
            <span className={s.home} />
          </div>
        </div>
      </div>
      <div className={s.now}>
        <i data-done={!!sim.ended || undefined} />
        <span role="status">{status}</span>
        {sim.until && !sim.ended && (
          <button
            type="button"
            className={b.ghostBtnPlain}
            onClick={() => setSim((x) => skip(x, graph, seed, names))}
          >
            Skip the wait
          </button>
        )}
        <button type="button" className={b.ghostBtnPlain} onClick={() => again()}>
          Play again
        </button>
      </div>
    </aside>
  );
}
