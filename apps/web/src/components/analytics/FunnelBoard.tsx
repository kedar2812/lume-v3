"use client";
import { plural } from "@lume/core/shared";
import { useEffect, useId, useState, type CSSProperties } from "react";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { analyticsClient, type AnalyticsParams, type Funnel } from "@/lib/analytics/client";
import { band, type Pt } from "@/lib/analytics/chart";
import { count, money, pct } from "@/lib/analytics/words";
import { Card, Chip, Skeleton } from "./parts";
import a from "./analytics.module.css";
import s from "./funnel.module.css";

type Split = "none" | "source" | "owner";
type Drill = (token: string, title: string) => void;

/** The groups' colours (canvas Funnel): sources in the blues, green and amber; people in their own four. */
const SOURCE_COLOURS = [
  ["#2a5bff", "#4d7bff"],
  ["#5ab8ff", "#7cc8ff"],
  ["#18a566", "#4fd69c"],
  ["#f2a20c", "#ffc75c"],
  ["#8a94a6", "#a8b0bf"],
  ["#0b7285", "#1395a8"],
] as const;
const OWNER_COLOURS = [
  ["#0b7285", "#1395a8"],
  ["#a15c00", "#c98316"],
  ["#0f7f44", "#1fa864"],
  ["#b02e6b", "#d24a8a"],
  ["#2a5bff", "#4d7bff"],
  ["#8a94a6", "#a8b0bf"],
] as const;
const W = 760;
const X0 = 40;
const X1 = 720;
const CY = 140;
const MAXH = 190;

/** "18 h", "1.6 d": how long a stay took. */
function dur(min: number | null): string {
  if (min === null) return "—";
  if (min < 60) return `${Math.max(1, Math.round(min))} min`;
  if (min < 1440) return `${Math.round(min / 60)} h`;
  return `${(min / 1440).toFixed(1).replace(/\.0$/, "")} d`;
}

/**
 * The Funnel board (canvas Funnel), card for card: how far the range's leads got, as a ribbon split by source or
 * owner; the stages now; time in each stage against its allowed time; what the pipeline earns a day; and the
 * forecast by month. Money cards only with the money permission (the API leaves them out otherwise).
 */
export function FunnelBoard({
  funnel,
  params,
  rangeWords,
  currency,
  onDrill,
}: {
  funnel: Funnel | null;
  params: AnalyticsParams;
  rangeWords: string;
  currency: string;
  onDrill: Drill;
}) {
  const [split, setSplit] = useState<Split>("none");
  const [byGroup, setByGroup] = useState<Funnel | null>(null);
  const key = JSON.stringify(params);
  // A split is its own ask: the board's numbers stay as they are while it comes.
  useEffect(() => {
    // A new range or split: the old split goes at once (never another range's layers under these numbers).
    setByGroup(null);
    if (split === "none") return;
    let live = true;
    void analyticsClient.funnel({ ...params, split }).then((r) => live && r.ok && setByGroup(r.data));
    return () => {
      live = false;
    };
    // `key` stands for params.
  }, [split, key]);
  if (!funnel)
    return (
      <div className={s.g2}>
        <Skeleton h={380} />
        <Skeleton h={380} i={1} />
      </div>
    );
  const money_ = (n: number) => money(n, currency);
  const v = funnel.velocity;
  const f = funnel.forecast;
  const moneyCards = [v, f].filter(Boolean).length;
  return (
    <>
      <div className={s.g2}>
        <Card
          title="How far the leads got"
          sub={`Of ${plural(funnel.arrived, "lead")} that arrived ${rangeWords}, the share that ever reached each stage, even if they skipped one`}
          right={
            <span className={s.gsel}>
              Split by
              <SegmentedControl
                label="Split the funnel by"
                value={split}
                options={[
                  { value: "none", label: "Nothing" },
                  { value: "source", label: "Source" },
                  { value: "owner", label: "Owner" },
                ]}
                onChange={(x) => setSplit(x as Split)}
              />
            </span>
          }
        >
          <Ribbon funnel={funnel} split={split === "none" ? null : byGroup} onDrill={onDrill} />
        </Card>
        <Card title="In each stage now" sub="Open leads and what they're worth, whatever the range" i={1}>
          <StagesNow funnel={funnel} money={money_} onDrill={onDrill} />
        </Card>
      </div>
      <div className={s.g3} data-cards={moneyCards + 1}>
        <Card
          title="Time in each stage"
          sub="Half of leads move on within the dark mark; three in four within the bar"
          i={2}
          right={<Stuck funnel={funnel} onDrill={onDrill} />}
        >
          <TimeInStage funnel={funnel} />
        </Card>
        {v && (
          <Card title="Pipeline velocity" sub="What the pipeline earns a day, at today's pace" i={3}>
            <Velocity v={v} money={money_} />
          </Card>
        )}
        {f && (
          <Card
            title="Forecast"
            sub="Open value × each stage's chance of winning, by the month LUME expects it"
            i={4}
          >
            <Forecast f={f} money={money_} />
          </Card>
        )}
      </div>
    </>
  );
}

/** The ribbon: centred, its height the share that got this far; split into layers when grouped. */
function Ribbon({ funnel, split, onDrill }: { funnel: Funnel; split: Funnel | null; onDrill: Drill }) {
  const clip = useId().replace(/:/g, "");
  const stages = funnel.stages;
  if (!funnel.arrived || stages.length < 2)
    return <p className={s.empty}>No leads arrived in this range yet. The funnel fills as they do.</p>;
  const n = stages.length;
  const xs = stages.map((_, i) => X0 + (i * (X1 - X0)) / (n - 1));
  const share = stages.map((st) => (funnel.arrived ? st.reached / funnel.arrived : 0));
  const h = share.map((x) => Math.max(8, x * MAXH));
  const groups = split?.split?.groups ?? [];
  const colours = split?.split?.by === "owner" ? OWNER_COLOURS : SOURCE_COLOURS;
  // Each group's part of a stage: its leads that reached it, of everyone's.
  const parts: { name: string; c: readonly [string, string]; frac: number[] }[] = groups.length
    ? groups.map((g, gi) => ({
        name: g.name,
        c: colours[gi % colours.length]!,
        frac: stages.map((st, i) => {
          const all = groups.reduce((a, x) => a + (x.stages[i]?.reached ?? 0), 0);
          return all ? (g.stages.find((x) => x.id === st.id)?.reached ?? 0) / all : 1 / groups.length;
        }),
      }))
    : [{ name: "Every lead that arrived", c: ["#2a5bff", "#5ab8ff"], frac: stages.map(() => 1) }];
  let acc = stages.map(() => 0);
  const layers = parts.map((p) => {
    const top: Pt[] = xs.map((x, i) => [x, CY - h[i]! / 2 + acc[i]! * h[i]!]);
    acc = acc.map((a, i) => a + p.frac[i]!);
    const bot: Pt[] = xs.map((x, i) => [x, CY - h[i]! / 2 + acc[i]! * h[i]!]);
    return { ...p, d: band(top, bot) };
  });
  // What leaves between two stages, falling away under the ribbon.
  const streams = xs.slice(0, -1).map((x, i) => {
    const w = ((h[i]! - h[i + 1]!) / MAXH) * 40 + 4;
    const y0 = CY + h[i + 1]! / 2;
    return `M${x + 20},${y0} C${x + 50},${y0} ${x + 60},${y0 + 30} ${x + 70},250 L${x + 70 + w},250 C${x + 66 + w},${y0 + 24} ${x + 54 + w},${y0 - 2} ${x + 20 + w * 2},${y0 - 2} Z`;
  });
  const anchor = (i: number) => (i === 0 ? "start" : i === n - 1 ? "end" : "middle");
  const colX = (i: number) => (i === 0 ? 0 : i === n - 1 ? W : xs[i]!);
  const lowestShown = (x: number, i: number) => pct(x, i === n - 1 && x < 0.1 ? 1 : 0);
  return (
    <>
      <div className={s.rib}>
        <svg viewBox={`0 0 ${W} 300`} role="img" aria-label="The funnel, as a ribbon">
          <defs>
            <clipPath id={clip}>
              <rect className={s.pour} x="0" y="0" width={W} height="300" />
            </clipPath>
            {layers.map((l, i) => (
              <linearGradient key={i} id={`${clip}-g${i}`} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor={l.c[0]} />
                <stop offset="1" stopColor={l.c[1]} />
              </linearGradient>
            ))}
          </defs>
          {stages.map((st, i) => (
            <g key={st.id}>
              <line className={s.col} x1={xs[i]} x2={xs[i]} y1="40" y2="252" />
              <text className={s.lab} x={colX(i)} y="18" textAnchor={anchor(i)}>
                {st.name}
              </text>
              <text className={s.num2} x={colX(i)} y="290" textAnchor={anchor(i)}>
                {lowestShown(share[i]!, i)}
              </text>
              <text className={s.lab2} x={colX(i)} y="270" textAnchor={anchor(i)}>
                {count(st.reached)} {st.reached === 1 ? "lead" : "leads"}
              </text>
            </g>
          ))}
          <g clipPath={`url(#${clip})`}>
            {streams.map((d, i) => (
              <path key={i} className={s.stream} d={d} />
            ))}
            {layers.map((l, i) => (
              <path key={i} className={s.band} d={l.d} fill={`url(#${clip}-g${i})`} />
            ))}
          </g>
        </svg>
        {/* From one stage to the next: the share that carried on. */}
        {xs.slice(0, -1).map((x, i) => (
          <span
            key={i}
            className={s.cpill}
            style={{ left: `${((x + xs[i + 1]!) / 2 / W) * 100}%`, top: `${((CY - 4) / 300) * 100}%` }}
            aria-hidden
          >
            <svg
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            >
              <path d="M2 6h8M7 3l3 3-3 3" />
            </svg>
            {stages[i]!.reached ? pct(stages[i + 1]!.reached / stages[i]!.reached) : "—"}
          </span>
        ))}
        {stages.map((st, i) =>
          st.drill?.reached && st.reached ? (
            <button
              key={st.id}
              type="button"
              className={s.colBtn}
              data-edge={i === 0 ? "start" : i === n - 1 ? "end" : undefined}
              style={{ left: `${(colX(i) / W) * 100}%` }}
              aria-label={`See the ${plural(st.reached, "lead")} that reached ${st.name}`}
              onClick={() => onDrill(st.drill!.reached!, `Reached ${st.name}`)}
            />
          ) : null,
        )}
      </div>
      <div className={a.legend} style={{ marginTop: 6 }}>
        {layers.map((l) => (
          <span key={l.name} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <i style={{ background: l.c[0] }} />
            {l.name}
          </span>
        ))}
      </div>
      <table className={s.srOnly}>
        <caption>How far the leads got</caption>
        <tbody>
          {stages.map((st, i) => (
            <tr key={st.id}>
              <th scope="row">{st.name}</th>
              <td>{count(st.reached)}</td>
              <td>{pct(share[i]!)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function StagesNow({ funnel, money, onDrill }: { funnel: Funnel; money(n: number): string; onDrill: Drill }) {
  const now = funnel.now;
  if (!now || !now.stages.length) return <p className={s.empty}>No open leads right now.</p>;
  const max = Math.max(1, ...now.stages.map((x) => x.n));
  return (
    <>
      <div className={s.snap}>
        {now.stages.map((st, i) => (
          <button
            key={st.id}
            type="button"
            className={s.sn}
            style={{ "--i": i } as CSSProperties}
            disabled={!st.drill || !st.n}
            aria-label={`${st.name}: ${count(st.n)} open${st.value !== undefined ? `, worth ${money(st.value)}` : ""}`}
            onClick={() => st.drill && onDrill(st.drill, `In ${st.name} now`)}
          >
            <b>{st.name}</b>
            <span className={s.tr3} data-filled={st.n / max > 0.18 || undefined}>
              <i
                style={{
                  width: `${(st.n / max) * 100}%`,
                  background: "linear-gradient(90deg, var(--accent), var(--sky))",
                }}
              />
              <span>{count(st.n)}</span>
            </span>
            <span className={s.val}>
              {st.value !== undefined ? (st.value ? money(st.value) : "—") : count(st.n)}
              <small>
                {st.value !== undefined
                  ? st.value && st.n
                    ? `avg ${money(st.value / st.n)}`
                    : "no value yet"
                  : st.avgAgeDays !== null
                    ? `${Math.round(st.avgAgeDays)} d here on average`
                    : ""}
              </small>
            </span>
          </button>
        ))}
      </div>
      <div className={s.velout} style={{ marginTop: 16 }}>
        <b>{now.openValue !== null ? money(now.openValue) : count(now.openN)}</b>
        <span>
          {now.openValue !== null
            ? `open across all stages · ${plural(now.openN, "lead")}`
            : "open leads across all stages"}
        </span>
      </div>
    </>
  );
}

function Stuck({ funnel, onDrill }: { funnel: Funnel; onDrill: Drill }) {
  const rows = funnel.timeInStage ?? [];
  const total = rows.reduce((a, r) => a + r.stuckNow, 0);
  if (!total) return null;
  const worst = [...rows].sort((a, b) => b.stuckNow - a.stuckNow)[0]!;
  return (
    <button
      type="button"
      className={a.link}
      onClick={() => worst.drill?.stuck && onDrill(worst.drill.stuck, `Stuck in ${worst.name}`)}
      title={`Most are in ${worst.name}`}
    >
      {count(total)} stuck
    </button>
  );
}

function TimeInStage({ funnel }: { funnel: Funnel }) {
  if (funnel.timeInStageNote) return <p className={s.note}>{funnel.timeInStageNote}</p>;
  const rows = funnel.timeInStage ?? [];
  const known = rows.filter((r) => r.p75Minutes !== null);
  if (!known.length) return <p className={s.empty}>No lead has moved on from a stage in this range yet.</p>;
  const max = Math.max(...known.map((r) => Math.max(r.p75Minutes!, (r.slaHours ?? 0) * 60))) * 1.1;
  return (
    <>
      <div className={s.tis}>
        {rows.map((r) => {
          const over = r.slaHours !== null && r.p75Minutes !== null && r.p75Minutes > r.slaHours * 60;
          return (
            <div
              key={r.id}
              className={s.ti}
              data-over={over || undefined}
              data-thin={r.tooFew || undefined}
              title={r.tooFew ? `Only ${r.exited} moved on: too few to say` : undefined}
            >
              <b>{r.name}</b>
              <span className={s.trk} aria-hidden>
                {r.p75Minutes !== null && (
                  <span className={s.rng} style={{ left: 0, width: `${(r.p75Minutes / max) * 100}%` }} />
                )}
                {r.medianMinutes !== null && (
                  <span
                    className={s.med}
                    style={{ left: `calc(${(r.medianMinutes / max) * 100}% - 1.5px)` }}
                  />
                )}
                {r.slaHours !== null && (
                  <span className={s.sla} style={{ left: `${((r.slaHours * 60) / max) * 100}%` }} />
                )}
              </span>
              <span className={s.tv}>
                {dur(r.medianMinutes)}
                <small>{r.p75Minutes !== null ? `P75 ${dur(r.p75Minutes)}` : `${r.exited} moved on`}</small>
              </span>
            </div>
          );
        })}
      </div>
      <div className={s.tleg}>
        <span>
          <i style={{ width: 3, height: 12, borderRadius: 2, background: "var(--text)" }} />
          Median
        </span>
        <span>
          <i style={{ width: 16, height: 8, borderRadius: 4, background: "var(--accent)" }} />
          Up to P75
        </span>
        <span>
          <i style={{ height: 12, borderLeft: "1.5px dashed var(--danger)" }} />
          The stage&apos;s allowed time
        </span>
      </div>
    </>
  );
}

function Velocity({ v, money }: { v: NonNullable<Funnel["velocity"]>; money(n: number): string }) {
  const hist = v.cycleHist;
  const top = hist ? Math.max(1, ...hist.counts) : 1;
  const edgeWords = (i: number) => {
    if (!hist) return "";
    const lo = i === 0 ? 0 : hist.edges[i - 1]!;
    const hi = hist.edges[i];
    return hi === undefined ? `${lo}+ days` : `${lo}–${hi} days`;
  };
  return (
    <>
      <div className={s.vel}>
        <div className={s.vt}>
          <b>{count(v.openLeads)}</b>
          <span>open leads</span>
        </div>
        <span className={s.op}>×</span>
        <div className={s.vt}>
          <b>{v.winRate !== null ? pct(v.winRate, v.winRate < 0.1 ? 1 : 0) : "—"}</b>
          <span>win rate</span>
        </div>
        <span className={s.op}>×</span>
        <div className={s.vt}>
          <b>{v.avgDeal !== null ? money(v.avgDeal) : "—"}</b>
          <span>average deal</span>
        </div>
        <span className={s.op}>÷</span>
        <div className={s.vt}>
          <b>{v.cycleDays !== null ? Math.round(v.cycleDays) : "—"}</b>
          <span>days to win</span>
        </div>
      </div>
      <div className={s.velout}>
        <b>{v.perDay !== null ? money(v.perDay) : "—"}</b>
        <span>{v.perDay !== null ? "a day" : "Too few wins to say"}</span>
        <Chip trend={v.trend} />
      </div>
      {hist && hist.counts.some((x) => x > 0) && (
        <>
          <div className={s.histTitle}>
            How long a win takes, from arriving · median{" "}
            {v.cycleDays !== null ? Math.round(v.cycleDays) : "—"} days
          </div>
          <div className={s.hist} role="img" aria-label="Wins by how many days they took">
            {hist.counts.map((x, i) => (
              <i
                key={i}
                data-median={i === hist.median || undefined}
                style={{ height: `${(x / top) * 100}%`, "--i": i } as CSSProperties}
                title={`${x} won in ${edgeWords(i)}`}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function Forecast({ f, money }: { f: NonNullable<Funnel["forecast"]>; money(n: number): string }) {
  const cols = [
    ...f.months.map((m) => ({ key: m.month, label: m.label, parts: [m.latest, m.second, m.earlier] })),
    ...(f.later ? [{ key: "later", label: "Later", parts: [0, 0, f.later] }] : []),
  ].map((c) => ({ ...c, total: c.parts.reduce((a, x) => a + x, 0) }));
  const top = Math.max(1, ...cols.map((c) => c.total));
  if (!cols.some((c) => c.total))
    return <p className={s.empty}>No open lead has a value yet, so there&apos;s nothing to forecast.</p>;
  const colours = ["var(--accent)", "var(--sky)", "rgba(var(--accent-rgb), 0.25)"];
  return (
    <>
      <div className={s.fcast}>
        {cols.map((c, i) => (
          <div key={c.key} className={s.fc} style={{ "--i": i } as CSSProperties}>
            <b>{money(c.total)}</b>
            <div className={s.stk} style={{ height: `${(c.total / top) * 100}%` }}>
              {c.parts.map((p, j) => (
                <i key={j} style={{ flex: p, background: colours[j] }} />
              ))}
            </div>
            <span>{c.label}</span>
          </div>
        ))}
      </div>
      <div className={a.legend} style={{ marginTop: 10 }}>
        {[f.stageNames[0], f.stageNames[1], "Earlier stages"].filter(Boolean).map((name, j) => (
          <span key={name} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <i style={{ background: colours[j] }} />
            {name}
          </span>
        ))}
      </div>
    </>
  );
}
