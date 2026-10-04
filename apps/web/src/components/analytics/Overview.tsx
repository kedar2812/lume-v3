"use client";
import { useMemo, useState, type CSSProperties } from "react";
import { METRICS, type MetricId } from "@lume/core/shared";
import type {
  Funnel,
  Goals,
  Insights,
  Overview as OverviewData,
  Quality,
  Timing,
} from "@/lib/analytics/client";
import { band, niceMax, smooth, toPts } from "@/lib/analytics/chart";
import { count, headline, money, pct, shown, type Period } from "@/lib/analytics/words";
import { Card, Chip, Ico, Skeleton, Spark } from "./parts";
import s from "./analytics.module.css";

/** Which numbers lead, in the canvas's order; money only when it's there. */
const ORDER: MetricId[] = [
  "new_leads",
  "contacted",
  "reply_rate",
  "calls_booked",
  "calls_held",
  "revenue_won",
  "won",
  "win_rate",
  "avg_deal",
  "speed_to_lead",
  "overdue_now",
  "forecast",
];
const BAND_COLORS = ["var(--accent)", "var(--sky)", "var(--ok)", "var(--warn)", "#8a94a6"];
const W = 640;
const H = 216;

export type OverviewProps = {
  data: OverviewData | null;
  funnel: Funnel | null;
  timing: Timing | null;
  quality: Quality | null;
  insights: Insights | null;
  goals: Goals | null;
  currency: string;
  compare: boolean;
  rangeWords: string;
  onDrill: (id: MetricId, title: string) => void;
  onTab: (tab: "funnel" | "timing" | "quality") => void;
  monthName: string;
  period: Period;
};

/** Overview (canvas Main): how the funnel is doing, whether the team follows up, and the money, at a glance. */
export function Overview(p: OverviewProps) {
  const { data, currency } = p;
  if (!data)
    return (
      <div aria-busy="true">
        <Skeleton h={44} />
        <div className={s.tiles} style={{ marginTop: 14 }}>
          {Array.from({ length: 12 }, (_, i) => (
            <Skeleton key={i} h={106} i={i} />
          ))}
        </div>
        <div className={s.row2}>
          <Skeleton h={300} />
          <Skeleton h={300} i={2} />
        </div>
      </div>
    );
  const tiles = ORDER.flatMap((id) => data.tiles.find((t) => t.id === id) ?? []);
  const head = headline(data.tiles, p.period);
  return (
    <>
      <div className={s.head}>
        <div>
          <h2>{head.title}</h2>
          {head.sub && <p>{head.sub}</p>}
        </div>
        <span className={s.stamp}>
          <i aria-hidden />
          Counted every 10 minutes
        </span>
      </div>

      <div className={s.tiles}>
        {tiles.map((t, i) => {
          const v = shown(t, currency);
          const m = METRICS[t.id];
          const hero = t.id === "revenue_won";
          const alarm = t.id === "overdue_now" && (t.value ?? 0) > 0;
          const spark =
            t.id === "new_leads"
              ? data.series.newLeads
              : t.id === "won" || t.id === "revenue_won"
                ? data.series.won
                : [];
          const tooFew = t.n !== undefined && t.n < 10 && m.unit !== "count" && m.unit !== "money";
          const canDrill = m.drill && !!data.drill[t.id];
          const label = `${m.words}: ${v.v}${v.unit ? ` ${v.unit}` : ""}${t.trend ? `, ${t.trend.text}` : ""}.${canDrill ? " See the leads." : ""}`;
          return (
            <button
              key={t.id}
              type="button"
              className={`${s.tile} ${hero ? s.hero : ""} ${alarm ? s.alarm : ""}`}
              style={{ "--i": i } as CSSProperties}
              title={m.info}
              aria-label={label}
              disabled={!canDrill}
              onClick={() => canDrill && p.onDrill(t.id, m.words)}
            >
              {canDrill && <span className={s.go}>{Ico.go}</span>}
              <div className={s.tileLabel}>{m.words}</div>
              <div className={s.tileValue}>
                {v.v}
                {v.unit && <small>{v.unit}</small>}
              </div>
              {tooFew ? (
                <span className={s.thin}>Too few to say yet</span>
              ) : (
                <Chip trend={p.compare ? t.trend : null} off={m.basis === "now" ? "Right now" : undefined} />
              )}
              {t.note && <span className={s.tileNote}>{t.note}</span>}
              <Spark values={spark} />
            </button>
          );
        })}
      </div>

      <div className={s.row2}>
        <Card
          title="New leads, by where they came from"
          sub={`Per day · ${p.compare ? "dashed: the period before" : "compare is off"}`}
          i={12}
        >
          <SourcesChart data={data} compare={p.compare} />
        </Card>
        <Card
          title="The funnel"
          sub={`Of the leads that arrived ${p.rangeWords}, how far they got`}
          i={13}
          right={
            <button type="button" className={s.link} onClick={() => p.onTab("funnel")}>
              Funnel{Ico.chevron}
            </button>
          }
        >
          <FunnelBars funnel={p.funnel} />
        </Card>
      </div>

      <div className={s.row3}>
        <Card title="Needs a look" sub="Right now, whatever the range" i={14}>
          <NeedsList data={data} timing={p.timing} quality={p.quality} onDrill={p.onDrill} onTab={p.onTab} />
        </Card>
        <Card title="LUME noticed" sub={`From your numbers ${p.rangeWords}`} i={15}>
          <Noticed insights={p.insights} />
        </Card>
        <Card title={`${p.monthName} goals`} sub="This month" i={16}>
          <GoalRing goals={p.goals} currency={currency} />
        </Card>
      </div>
    </>
  );
}

function SourcesChart({ data, compare }: { data: OverviewData; compare: boolean }) {
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [hi, setHi] = useState<number | null>(null);
  const series = data.series.bySource;
  const days = data.series.days;
  const n = days.length;
  const shownSeries = series.filter((x) => !hidden[x.id ?? "none"]);
  const totals = days.map((_, i) => shownSeries.reduce((a, x) => a + (x.values[i] ?? 0), 0));
  const prevTotals = data.series.previous.newLeads;
  const max = niceMax(Math.max(1, ...totals, ...(compare ? prevTotals : [])) * 1.08);
  const bands = useMemo(() => {
    let base = Array(n).fill(0) as number[];
    return series.map((x, k) => {
      const on = !hidden[x.id ?? "none"];
      const top = base.map((b, i) => b + (on ? (x.values[i] ?? 0) : 0));
      const d = band(toPts(top, W, H, max, 6), toPts(base, W, H, max, 6));
      base = top;
      return { key: x.id ?? "none", d, color: BAND_COLORS[k % BAND_COLORS.length]!, on };
    });
  }, [series, hidden, max, n]);
  if (!n || (totals.every((v) => v === 0) && prevTotals.every((v) => v === 0)))
    return <p className={s.empty}>No new leads in this range yet.</p>;
  const step = n > 1 ? (W - 12) / (n - 1) : 0;
  const words = (d: string) =>
    new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  const labels =
    n > 1 ? [0, Math.round((n - 1) / 4), Math.round((n - 1) / 2), Math.round((3 * (n - 1)) / 4), n - 1] : [0];
  return (
    <>
      <div className={s.legend} style={{ marginBottom: 8 }}>
        {series.map((x, k) => (
          <button
            key={x.id ?? "none"}
            type="button"
            aria-pressed={!hidden[x.id ?? "none"]}
            onClick={() => setHidden((h) => ({ ...h, [x.id ?? "none"]: !h[x.id ?? "none"] }))}
          >
            <i style={{ background: BAND_COLORS[k % BAND_COLORS.length] }} />
            {x.name}
          </button>
        ))}
      </div>
      <div className={s.chart} style={{ height: 236 }}>
        <svg
          viewBox={`0 0 ${W} 236`}
          preserveAspectRatio="none"
          style={{ height: 236 }}
          role="img"
          aria-label="New leads per day, by source"
        >
          {[0, 0.25, 0.5, 0.75].map((f) => {
            const y = 6 + f * (H - 12);
            return (
              <g key={f}>
                <line className={s.gridLine} x1="0" x2={W} y1={y} y2={y} />
                <text className={s.axis} x="0" y={y - 4}>
                  {count(max * (1 - f))}
                </text>
              </g>
            );
          })}
          {[...bands].reverse().map((b) => (
            <path
              key={b.key}
              className={s.band}
              d={b.d}
              fill={b.color}
              fillOpacity={0.5}
              style={{ opacity: b.on ? 1 : 0 }}
            />
          ))}
          {compare && prevTotals.length === n && (
            <path className={s.prev} d={smooth(toPts(prevTotals, W, H, max, 6))} />
          )}
          {hi !== null && <line className={s.hov} x1={6 + hi * step} x2={6 + hi * step} y1="8" y2="216" />}
          {labels.map((i) => (
            <text key={i} className={s.axis} x={6 + i * step} y="234" textAnchor="middle">
              {words(days[i]!).replace(/^(\w{3})\w*/, "$1")}
            </text>
          ))}
        </svg>
        <div
          style={{ position: "absolute", inset: 0 }}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setHi(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
          }}
          onPointerLeave={() => setHi(null)}
        />
        {hi !== null && (
          <div
            className={s.tip}
            style={{
              left: `clamp(0px, calc(${(hi / Math.max(1, n - 1)) * 100}% - 84px), calc(100% - 180px))`,
            }}
          >
            <b>{words(days[hi]!)}</b>
            {shownSeries.map((x) => (
              <div key={x.id ?? "none"} className={s.tipRow}>
                <span>
                  <i style={{ background: BAND_COLORS[series.indexOf(x) % BAND_COLORS.length] }} />
                  {x.name}
                </span>
                <em>{count(x.values[hi] ?? 0)}</em>
              </div>
            ))}
            <div
              className={s.tipRow}
              style={{ borderTop: "0.5px solid var(--line)", marginTop: 6, paddingTop: 6 }}
            >
              <span>All sources</span>
              <em>{count(totals[hi] ?? 0)}</em>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

export function FunnelBars({ funnel }: { funnel: Funnel | null }) {
  if (!funnel) return <Skeleton h={220} />;
  if (!funnel.arrived)
    return <p className={s.empty}>No leads arrived in this range, so there’s no funnel to show.</p>;
  return (
    <div className={s.funnel}>
      {funnel.stages.map((st, i) => (
        <div key={st.id}>
          <div className={s.stage}>
            <span className={s.stageName}>{st.name}</span>
            <span className={s.track}>
              <span
                className={s.fill}
                data-won={st.kind === "won" || undefined}
                data-thin={st.tooFew || undefined}
                style={{ width: `${Math.max(4, (st.share ?? 0) * 100)}%`, "--i": i } as CSSProperties}
              >
                <b>{count(st.reached)}</b>
              </span>
            </span>
            <span className={s.share}>
              {st.share === null ? "—" : pct(st.share, st.share > 0 && st.share < 0.1 ? 1 : 0)}
            </span>
          </div>
          {i < funnel.stages.length - 1 && st.stoppedN > 0 && (
            <div className={s.drop}>
              <span>
                {count(st.stoppedN)} stopped here · {st.stopped !== null ? `−${pct(st.stopped)}` : ""}
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function NeedsList(p: {
  data: OverviewData;
  timing: Timing | null;
  quality: Quality | null;
  onDrill: OverviewProps["onDrill"];
  onTab: OverviewProps["onTab"];
}) {
  const overdue = p.data.tiles.find((t) => t.id === "overdue_now")?.value ?? 0;
  const stuck = p.timing?.stages.reduce((a, x) => a + x.stuckNow, 0) ?? null;
  const unowned = p.quality
    ? p.quality.unowned.under1h + p.quality.unowned.under1d + p.quality.unowned.over1d
    : null;
  const country = p.quality?.phoneNeedsCountry ?? null;
  const rows = [
    {
      tone: "red",
      ic: Ico.clock,
      title: "Follow-ups overdue",
      sub: "Past their time, still open",
      n: overdue,
      go: () => p.onDrill("overdue_now", "Follow-ups overdue"),
    },
    {
      tone: "amber",
      ic: Ico.stuck,
      title: "Stuck in a stage",
      sub: "Past the time their stage allows",
      n: stuck,
      go: () => p.onTab("timing"),
    },
    {
      tone: "blue",
      ic: Ico.user,
      title: "Nobody yet",
      sub: "Leads without an owner",
      n: unowned,
      go: () => p.onTab("quality"),
    },
    {
      tone: "grey",
      ic: Ico.globe,
      title: "Numbers need a country",
      sub: "LUME couldn’t read them",
      n: country,
      go: () => p.onTab("quality"),
    },
  ];
  return (
    <div className={s.list}>
      {rows.map((r) => (
        <button key={r.title} type="button" className={s.item} onClick={r.go}>
          <span className={s.ic} data-tone={r.tone}>
            {r.ic}
          </span>
          <div>
            <b>{r.title}</b>
            <small>{r.sub}</small>
          </div>
          <span className={s.num}>{r.n === null ? "—" : count(r.n)}</span>
        </button>
      ))}
    </div>
  );
}

function Noticed({ insights }: { insights: Insights | null }) {
  if (!insights) return <Skeleton h={160} />;
  if (!insights.ready) {
    const n = Number(insights.progress.match(/^[\d,]+/)?.[0]?.replace(/,/g, "") ?? 0);
    return (
      <div className={s.waiting}>
        <b>{insights.title}</b>
        <p style={{ margin: "4px 0 0" }}>{insights.body}</p>
        <div className={s.progress} aria-hidden>
          <i style={{ transform: `scaleX(${Math.min(1, n / 200)})` }} />
        </div>
        <small>{insights.progress}</small>
      </div>
    );
  }
  if (!insights.insights.length)
    return <p className={s.empty}>Nothing stands out in these numbers. LUME will say when something does.</p>;
  return (
    <div className={s.notices}>
      {insights.insights.map((n) => (
        <div key={`${n.id}:${n.subject}`} className={s.notice}>
          <span className={s.mark}>
            <img src="/lume-mark.png" alt="" />
          </span>
          <div>
            <b>{n.title}</b>
            <p>{n.body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

const GOAL_WORDS = {
  won: "Won",
  revenue: "Revenue",
  calls_held: "Calls held",
  new_leads: "New leads",
  ontime: "Follow-ups on time",
};

function GoalRing({ goals, currency }: { goals: Goals | null; currency: string }) {
  if (!goals) return <Skeleton h={120} />;
  const business = goals.goals.filter((g) => g.scope === "business" || g.scope === "user");
  if (!business.length)
    return <p className={s.empty}>No goals set for this month. Admins set them in Settings → Goals.</p>;
  const lead = business.find((g) => g.metric === "revenue") ?? business[0]!;
  const val = (g: (typeof business)[number], v: number) =>
    g.metric === "revenue" ? money(v, currency) : g.metric === "ontime" ? pct(v) : count(v);
  return (
    <div className={s.goal}>
      <div className={s.ring}>
        <svg viewBox="0 0 118 118" aria-hidden>
          <circle className={s.ringBg} cx="59" cy="59" r="53" />
          <circle
            className={s.ringFg}
            cx="59"
            cy="59"
            r="53"
            style={{ strokeDashoffset: 333 - 333 * Math.min(1, lead.progress) }}
          />
        </svg>
        <div className={s.ringCtr}>
          <div>
            <b>{pct(Math.min(9.99, lead.progress))}</b>
            <span>of {GOAL_WORDS[lead.metric].toLowerCase()} goal</span>
          </div>
        </div>
      </div>
      <div className={s.gbars}>
        {business.slice(0, 3).map((g) => (
          <div key={g.id} className={s.gbar} data-met={g.progress >= 1 || undefined}>
            <div>
              <b>{GOAL_WORDS[g.metric]}</b>
              <span>
                {val(g, g.value)} of {val(g, g.target)}
                {g.pace !== null && g.daysLeft > 0 ? ` · at this pace, ${pct(Math.min(9.99, g.pace))}` : ""}
              </span>
            </div>
            <div className={s.gtrack}>
              <i style={{ transform: `scaleX(${Math.min(1, g.progress)})` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
