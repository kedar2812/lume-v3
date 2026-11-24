"use client";
import { useEffect, useState } from "react";
import { GRAPH_LIMITS, type FlowGraph } from "@lume/core/shared";
import { flowsClient, type FlowPerson, type FlowRun } from "@/lib/flows/client";
import { KINDS, summary } from "./kinds";
import { PanelHead, type Tool } from "./PanelHead";
import b from "./builder.module.css";
import p from "./panels.module.css";

const time = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" });
const day = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});
const at = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? time.format(d) : day.format(d);
};
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => Array.from(w)[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
const STATUS: Record<string, string> = {
  running: "In the flow now",
  waiting: "In the flow now",
  done: "Finished",
  handed: "Passed to your team",
  stopped: "Stopped",
  failed: "Couldn't go on",
};
const WAIT: Record<"reply" | "answer" | "time" | "message", string> = {
  reply: "Waiting here for a tap on a quick reply",
  answer: "Waiting here for their answer",
  time: "Waiting here",
  message: "Waiting for their next message",
};
const SEARCH_MS = 250;

/**
 * Replay (plan 2026-11-23-flow-builder, Task B4; board BuilderTest): where a lead got to in this flow, and why. Pick
 * someone who went through it (newest first, or search by name); their run's steps light up on the canvas, with where
 * it waits and until when. Only leads the viewer may see are listed.
 */
export function ReplayPanel({
  flowId,
  graph,
  onTool,
  onClose,
  onLit,
}: {
  flowId: string;
  graph: FlowGraph;
  onTool: (t: Tool) => void;
  onClose: () => void;
  onLit: (ids: string[]) => void;
}) {
  const [q, setQ] = useState("");
  const [people, setPeople] = useState<FlowPerson[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [who, setWho] = useState<FlowPerson | null>(null);
  const [runs, setRuns] = useState<FlowRun[] | null>(null);
  const [runsFailed, setRunsFailed] = useState<string | null>(null);
  const [runIdx, setRunIdx] = useState(0);

  // The list, again a moment after the search changes (never one request per letter); the last answer wins.
  useEffect(() => {
    let live = true;
    const t = setTimeout(
      async () => {
        const r = await flowsClient.people(flowId, q);
        if (!live) return;
        if (r.ok) {
          setPeople(r.data.people);
          setFailed(null);
        } else setFailed(r.message);
      },
      q ? SEARCH_MS : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [flowId, q]);

  useEffect(() => {
    if (!who) return;
    let live = true;
    setRuns(null);
    setRunsFailed(null);
    setRunIdx(0);
    void flowsClient.runs(flowId, who.leadId).then((r) => {
      if (!live) return;
      if (r.ok) setRuns(r.data.runs);
      else setRunsFailed(r.message);
    });
    return () => {
      live = false;
    };
  }, [flowId, who]);

  const run = runs?.[runIdx] ?? null;
  useEffect(() => onLit(run ? [...new Set(run.trail.map((t) => t.step))] : []), [run, onLit]);
  useEffect(() => () => onLit([]), [onLit]);

  const name = (id: string | null) => {
    const n = id ? graph.nodes.find((x) => x.id === id) : undefined;
    return n ? `${KINDS[n.type].label}: ${summary(n)}` : "A step that isn't in the flow now";
  };

  return (
    <aside className={b.insp} aria-label="Replay" data-tool>
      <PanelHead tool="replay" onTool={onTool} onClose={onClose} />
      <div className={p.body}>
        <p className={p.title}>Where a lead got to, and why.</p>
        {who === null ? (
          <>
            <input
              className={p.search}
              type="search"
              aria-label="Find someone by name"
              placeholder="Find someone by name"
              maxLength={100}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {failed ? (
              <p className={p.said}>{failed}</p>
            ) : people === null ? (
              <div aria-busy="true" aria-label="Loading who went through it">
                <div className={p.skel} />
              </div>
            ) : people.length === 0 ? (
              <p className={p.cap}>
                {q.trim()
                  ? "Nobody by that name has been through this flow lately."
                  : "Nobody has been through this flow yet. Once it's live, everyone it talks to is here."}
              </p>
            ) : (
              <div
                role="list"
                aria-label="Who went through it"
                style={{ display: "flex", flexDirection: "column" }}
              >
                {people.map((x) => (
                  <div role="listitem" key={x.leadId}>
                    <button type="button" className={p.who} onClick={() => setWho(x)}>
                      <span className={p.av} aria-hidden>
                        {x.photo ? <img src={x.photo} alt="" /> : initials(x.name)}
                      </span>
                      <span className={p.whoText}>
                        <b>{x.name}</b>
                        <span>
                          Started {at(x.startedAt)} · {STATUS[x.status] ?? x.status}
                        </span>
                      </span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              className={p.who}
              data-on=""
              onClick={() => {
                setWho(null);
                setRuns(null);
                setRunsFailed(null);
              }}
            >
              <span className={p.av} aria-hidden>
                {who.photo ? <img src={who.photo} alt="" /> : initials(who.name)}
              </span>
              <span className={p.whoText}>
                <b>{who.name}</b>
                <span>Choose someone else</span>
              </span>
            </button>
            {runsFailed ? (
              <p className={p.said}>{runsFailed}</p>
            ) : runs === null ? (
              <div aria-busy="true" aria-label="Loading their way through it">
                <div className={p.skel} />
              </div>
            ) : runs.length === 0 || !run ? (
              <p className={p.cap}>Nothing to show for them now.</p>
            ) : (
              <>
                {runs.length > 1 && (
                  <div className={p.runs} role="group" aria-label="Their times through it">
                    {runs.map((r, i) => (
                      <button
                        key={r.id}
                        type="button"
                        aria-pressed={i === runIdx}
                        onClick={() => setRunIdx(i)}
                      >
                        {i === 0 ? "Latest" : at(r.startedAt)}
                      </button>
                    ))}
                  </div>
                )}
                <ol className={p.trail} aria-label="Their way through it">
                  {run.trail.map((t, i) => (
                    <li key={`${t.step}-${i}`}>
                      <i />
                      <span className={p.step}>
                        <b>{name(t.step)}</b>
                        <span>{at(t.at)}</span>
                      </span>
                    </li>
                  ))}
                  {run.waiting ? (
                    <li>
                      <i data-wait="" />
                      <span className={p.step}>
                        <b>{WAIT[run.waiting.why]}</b>
                        <span>
                          {run.waiting.why === "time" && run.waiting.until
                            ? `Goes on at ${at(run.waiting.until)}.`
                            : run.waiting.why === "answer" && run.waiting.until
                              ? `If no answer comes, it goes on at ${at(run.waiting.until)}.`
                              : "Nothing more happens until they write or tap."}
                        </span>
                      </span>
                    </li>
                  ) : (
                    <li>
                      <i data-end="" />
                      <span className={p.step}>
                        <b>{STATUS[run.status] ?? run.status}</b>
                        {run.reason && run.reason !== "finished" && <span>{run.reason}</span>}
                      </span>
                    </li>
                  )}
                </ol>
                <div className={p.facts}>
                  <div>
                    Messages this run sent
                    <b>
                      {run.sent} of {GRAPH_LIMITS.sends}
                    </b>
                  </div>
                  <div>
                    Version it went through
                    <b>{run.version}</b>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
