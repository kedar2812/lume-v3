"use client";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { GNode } from "@lume/core/shared";
import { StartsChart, answerTime } from "@/components/analytics/InstagramBoard";
import { Card } from "@/components/analytics/parts";
import a from "@/components/analytics/analytics.module.css";
import { count, money, pct } from "@/lib/analytics/words";
import {
  flowsClient,
  type FlowListItem,
  type FlowRange,
  type FlowSource,
  type FlowsSummary,
} from "@/lib/flows/client";
import { KINDS, summary } from "./builder/kinds";
import s from "./flows.module.css";

const DASH = "—";
const TOO_FEW = 10;
/** A share of a whole, or a dash when there's nothing to divide by (never NaN). */
const share = (part: number, whole: number) => (whole > 0 ? pct(part / whole) : DASH);
const time = (sec: number | null) => {
  const t = answerTime(sec);
  return t.unit ? `${t.v} ${t.unit}` : t.v;
};
/** The steps a person goes through, named as their cards are (a message, a question, a booking, a hand-off). */
const PERSON_STEPS = new Set<GNode["type"]>(["message", "ask", "book", "handoff"]);

const KIND_WORDS: Record<string, string> = {
  ad: "Ad",
  reels: "Reel",
  reel: "Reel",
  video: "Video",
  image: "Post",
  carousel_album: "Post",
  post: "Post",
};

/**
 * The Flows board (plan 2026-11-25-instagram-screens D6b-2; canvas board Flows): what the flows did over the
 * business's days, conversations they answered by what started them, where people stop (all flows, or one flow's
 * steps), the posts and ads that started them, and what LUME noticed.
 */
export function FlowsBoard({
  sum,
  flows,
  range,
  currency,
}: {
  sum: FlowsSummary;
  flows: FlowListItem[];
  /** The days these numbers are for (the Flows page's range picker). */
  range: FlowRange;
  /** The business's currency; without it, no money is shown (never a made-up one). */
  currency: string | null;
}) {
  const t = sum.total;
  const tiles: { label: string; v: string; note: string; hero?: boolean }[] = [
    { label: "Conversations started", v: count(t.triggered), note: "People a flow answered" },
    { label: "Finished the flow", v: share(t.finished, t.triggered), note: "Got to the last step" },
    { label: "Became leads", v: count(t.leads), note: `${share(t.leads, t.triggered)} who started` },
    { label: "Calls booked", v: count(t.booked), note: "After a flow answered them" },
    { label: "Won", v: count(t.won), note: "After a flow answered them" },
    ...(t.revenue !== null && currency
      ? [
          {
            label: "Revenue won",
            v: money(t.revenue, currency),
            note: `From ${count(t.won)} ${t.won === 1 ? "lead" : "leads"} won after a flow`,
            hero: true,
          },
        ]
      : []),
    { label: "Lead rate", v: share(t.leads, t.triggered), note: "Started, then became a lead" },
    { label: "First answer (median)", v: time(t.firstAnswerSec), note: "From their message to the flow’s" },
    { label: "Passed to your team", v: count(t.handed), note: "A flow asked for a person" },
    {
      label: "Your team’s answer (median)",
      v: time(t.teamAnswerSec),
      note: "After a flow passed someone on",
    },
    {
      label: "Time to answer ran out",
      v: count(t.ranOut),
      note: "Passed on, nobody answered in Instagram’s window",
    },
    { label: "Asked to stop", v: count(t.stopped), note: "LUME won’t message them again" },
  ];
  return (
    <>
      <ul className={s.tiles} aria-label="What the flows did">
        {tiles.map((x) => (
          <li key={x.label} className={s.tile} data-hero={x.hero || undefined}>
            <span className={s.tileLabel}>{x.label}</span>
            <b className={s.tileValue}>{x.v}</b>
            <span className={s.tileNote}>{x.note}</span>
          </li>
        ))}
      </ul>
      <div className={a.row2}>
        <Card title="Conversations started, by what started them" sub="Per day" i={0}>
          <StartsChart series={sum.series} />
        </Card>
        <WhereTheyStop sum={sum} flows={flows} range={range} />
      </div>
      <div className={a.row2}>
        <Sources sum={sum} flows={flows} />
        <Card title="LUME noticed" sub="From these numbers" i={3}>
          {sum.notes.length ? (
            <ul className={s.notes}>
              {sum.notes.map((n) => (
                <li key={n.id}>
                  <b>{n.title}</b>
                  <span>
                    {n.flowId && flows.find((f) => f.id === n.flowId) && (
                      <>{flows.find((f) => f.id === n.flowId)!.name}: </>
                    )}
                    {n.body}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className={a.empty}>Nothing stands out yet in these numbers.</p>
          )}
        </Card>
      </div>
    </>
  );
}

type Step = { name: string; n: number; outcome?: boolean };

/** Where people stop: all flows' path, or one flow's steps in the order runs reach them; the biggest drop marked. */
function WhereTheyStop({
  sum,
  flows,
  range,
}: {
  sum: FlowsSummary;
  flows: FlowListItem[];
  range: FlowRange;
}) {
  const [pick, setPick] = useState("");
  const [one, setOne] = useState<{ id: string; steps: Step[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const started = flows.filter((f) => (sum.flows.find((x) => x.id === f.id)?.triggered ?? 0) > 0);
  useEffect(() => {
    setFailed(false);
    if (!pick) return setOne(null);
    let live = true;
    void Promise.all([flowsClient.stats(pick, range), flowsClient.get(pick)]).then(([st, view]) => {
      if (!live) return;
      if (!st.ok || !view.ok) {
        setOne(null);
        return setFailed(true);
      }
      const row = sum.flows.find((x) => x.id === pick);
      const graph = view.data.live && "v" in view.data.live.steps ? view.data.live.steps : view.data.graph;
      const steps = graph.nodes
        .filter((n) => PERSON_STEPS.has(n.type) && st.data.byStep[n.id])
        .map((n, i) => ({
          i,
          name: `${KINDS[n.type].label}: ${summary(n)}`,
          n: st.data.byStep[n.id]!.entered,
        }))
        .sort((x, y) => y.n - x.n || x.i - y.i)
        .map(({ name, n }) => ({ name, n }));
      setOne({
        id: pick,
        steps: [
          { name: "Started", n: st.data.total.triggered },
          ...steps,
          { name: "Became a lead", n: row?.leads ?? st.data.total.leads, outcome: true },
          { name: "Booked a call", n: row?.booked ?? st.data.total.booked, outcome: true },
          { name: "Won", n: row?.won ?? st.data.total.won, outcome: true },
        ],
      });
    });
    return () => {
      live = false;
    };
  }, [pick, range, sum]);
  const t = sum.total;
  const steps: Step[] =
    pick && one?.id === pick
      ? one.steps
      : [
          { name: "Started", n: t.triggered },
          { name: "Finished the flow", n: t.finished },
          // The leads the flows made, and how far those got: each step within the one before.
          { name: "Became a lead", n: t.leads, outcome: true },
          { name: "Booked a call", n: t.bookedNew, outcome: true },
          { name: "Won", n: t.wonNew, outcome: true },
        ];
  return (
    <Card
      title="Where people stop"
      sub={pick ? "Each step of this flow, in the order people reach it" : "Every flow, from start to won"}
      i={1}
      right={
        started.length > 0 ? (
          <label className={s.pick}>
            <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Flow">
              <option value="">All flows</option>
              {started.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        ) : undefined
      }
    >
      {failed ? (
        <p role="status" className={a.empty}>
          LUME couldn’t read this flow’s steps just now. Pick it again to try.
        </p>
      ) : pick && one?.id !== pick ? (
        <p className={a.empty} aria-busy="true">
          Counting this flow’s steps…
        </p>
      ) : (
        <StopBars steps={steps} />
      )}
    </Card>
  );
}

/** The steps as bars out of the first; the step after which the most people stop is marked (from 10 people on). */
export function StopBars({ steps }: { steps: Step[] }) {
  const first = steps[0]?.n ?? 0;
  if (!first)
    return <p className={a.empty}>No one started a flow in these days, so there’s nothing to follow.</p>;
  let worst = -1;
  let loss = -1;
  steps.forEach((st, i) => {
    const next = steps[i + 1];
    if (!next || next.outcome || st.n < TOO_FEW) return;
    const l = 1 - next.n / st.n;
    if (l > loss) {
      loss = l;
      worst = i;
    }
  });
  return (
    <div className={a.funnel}>
      {steps.map((st, i) => {
        const part = st.n / first;
        const next = steps[i + 1];
        return (
          <div key={`${i}:${st.name}`}>
            <div className={a.stage}>
              <span className={a.stageName} title={st.name}>
                {st.name}
              </span>
              <span className={a.track}>
                <span
                  className={a.fill}
                  data-won={st.name === "Won" || undefined}
                  style={{ width: `${Math.max(4, Math.min(1, part) * 100)}%`, "--i": i } as CSSProperties}
                >
                  <b>{count(st.n)}</b>
                </span>
              </span>
              <span className={a.share}>{pct(part, part > 0 && part < 0.1 ? 1 : 0)}</span>
            </div>
            {i === worst && next && (
              <div className={a.drop} data-worst>
                <span>{count(st.n - next.n)} stopped here · the most of any step</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Sources({ sum, flows }: { sum: FlowsSummary; flows: FlowListItem[] }) {
  const [pick, setPick] = useState("");
  const list: FlowSource[] = useMemo(
    () => (pick ? sum.sourcesByFlow.filter((x) => x.flowId === pick) : sum.sources),
    [pick, sum],
  );
  const withSources = flows.filter((f) => sum.sourcesByFlow.some((x) => x.flowId === f.id));
  return (
    <Card
      title="The posts and ads that started them"
      sub="By the leads they brought"
      i={2}
      right={
        withSources.length > 1 ? (
          <label className={s.pick}>
            <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Posts and ads of">
              <option value="">All flows</option>
              {withSources.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        ) : undefined
      }
    >
      {!list.length ? (
        <p className={a.empty}>No post or ad started a flow in these days yet.</p>
      ) : (
        <ul className={s.srcs}>
          {list.map((x) => (
            <li key={`${x.kind}:${x.id}`}>
              <span className={s.srcName}>
                {KIND_WORDS[x.kind] ?? "Post"}
                <small title={x.id}>{x.id}</small>
              </span>
              <span className={s.srcNums}>
                <span>
                  <b>{count(x.conversations)}</b> started
                </span>
                <span>
                  <b>{count(x.leads)}</b> {x.leads === 1 ? "lead" : "leads"}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
