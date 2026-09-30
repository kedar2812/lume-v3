"use client";
import { useCallback, useEffect, useState } from "react";
import type { Analytics } from "@/lib/analytics";
import { api, CHANGED } from "@/lib/client";
import { month } from "@/lib/format";
import { inr, shortInr } from "@/lib/money";
import { countryName, INDIA_STATES } from "@/lib/places";
import { ARROWS, MINUS, trend, type Trend } from "@/lib/trend";
import { Bell } from "./Bell";
import { Delta, Flag } from "./bits";
import { SOURCE_WORDS } from "./NewLicence";
import { Head } from "./Shell";

type Data = Analytics & {
  rates: { day: string | null; ageDays: number | null; rates: Record<string, number> };
};
type Range = 3 | 6 | 12;

const CUR_COLOR: Record<string, string> = {
  INR: "#2a5bff",
  AED: "#18a566",
  SGD: "#f2a20c",
  USD: "#8b5cf6",
  EUR: "#14b8a6",
  AUD: "#ec4899",
  GBP: "#64748b",
};
const EXTRA = ["#0ea5e9", "#f97316", "#84cc16", "#a855f7", "#e11d48"];
const IDEA_LOOK: Record<string, { tone: string; icon: string }> = {
  source: {
    tone: "tone-green",
    icon: "M5.5 7.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM1.5 13.5c0-2.2 1.8-4 4-4s4 1.8 4 4M11 5.5h4M13 3.5v4",
  },
  abroad: {
    tone: "tone-blue",
    icon: "M8 14.5a6.5 6.5 0 100-13 6.5 6.5 0 000 13zM1.5 8h13M8 1.5c1.8 2 2.5 4 2.5 6.5S9.8 12.5 8 14.5C6.2 12.5 5.5 10.5 5.5 8S6.2 3.5 8 1.5z",
  },
  below: { tone: "tone-amber", icon: "M2.5 11.5l4-4 3 3 4-5M10.5 5.5h3v3" },
  pace: {
    tone: "tone-violet",
    icon: "M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M8 10.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z",
  },
  down: { tone: "tone-red", icon: "M1.5 4.5L6 9l3-3 5.5 5.5M10 11.5h4.5V7" },
};

/** A tidy top for an axis: the next of 1, 1.2, 1.5, 2… times a power of ten. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * mag >= v) return m * mag;
  return 10 * mag;
}
/** A smooth line through points that never overshoots between them (monotone cubic). */
function smooth(p: [number, number][]): string {
  const n = p.length;
  if (n < 2) return "";
  const f = (x: number) => x.toFixed(1);
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = p[i + 1]![0] - p[i]![0];
    m[i] = (p[i + 1]![1] - p[i]![1]) / dx[i]!;
  }
  const t: number[] = [m[0]!];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2;
  t[n - 1] = m[n - 2]!;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i]! / m[i]!;
    const b = t[i + 1]! / m[i]!;
    const h = a * a + b * b;
    if (h > 9) {
      const s = 3 / Math.sqrt(h);
      t[i] = s * a * m[i]!;
      t[i + 1] = s * b * m[i]!;
    }
  }
  let d = `M${f(p[0]![0])} ${f(p[0]![1])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]! / 3;
    d += ` C${f(p[i]![0] + h)} ${f(p[i]![1] + t[i]! * h)} ${f(p[i + 1]![0] - h)} ${f(p[i + 1]![1] - t[i + 1]! * h)} ${f(p[i + 1]![0])} ${f(p[i + 1]![1])}`;
  }
  return d;
}
const TONE_INK = { good: "var(--greenInk)", bad: "var(--redInk)", flat: "var(--ink3)" } as const;

/** Analytics (canvas: AdminAnalytics): every number in ₹ at today's rates, every change by the one trend rule. */
export function AnalyticsScreen() {
  const [range, setRange] = useState<Range>(12);
  const [a, setA] = useState<Data | null>(null);
  const [gen, setGen] = useState(0);
  const [hover, setHover] = useState(-1);
  const [who, setWho] = useState<"all" | "fresh">("all");
  const [spot, setSpot] = useState(-1);

  const load = useCallback(async (r: Range) => {
    const res = await api.get<Data>(`/api/analytics?range=${r}`);
    if (res.ok) setA(res.data);
  }, []);
  useEffect(() => {
    void load(range);
    const again = () => void load(range);
    window.addEventListener(CHANGED, again);
    return () => window.removeEventListener(CHANGED, again);
  }, [load, range]);

  const pick = (r: Range) => {
    if (r === range) return;
    setRange(r);
    setHover(-1);
    setGen((g) => g + 1);
  };

  const head = (
    <Head title="Analytics" sub="How LUME is growing. Every amount is in ₹, converted at today's rates.">
      <div className="seg" role="radiogroup" aria-label="Period" style={{ width: 162 }}>
        <span
          className="segpill"
          style={{ width: 52, transform: `translateX(${[3, 6, 12].indexOf(range) * 52}px)` }}
          aria-hidden
        />
        {([3, 6, 12] as const).map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={r === range}
            onClick={() => pick(r)}
            style={{ width: 52 }}
          >
            {r}M
          </button>
        ))}
      </div>
      <Bell />
    </Head>
  );
  if (!a) return head;

  const series = a.series;
  const vs = month(series[series.length - 2]!.month);
  const g = Math.round(a.growth * 1000) / 10;
  const gTone = g > 0 ? "good" : g < 0 ? "bad" : "flat";
  const firstPaid = series.findIndex((p) => p.mrr > 0);
  const months = firstPaid >= 0 ? series.length - 1 - firstPaid : 0;

  // The chart (the canvas's geometry).
  const W = 713;
  const B = 216;
  const T = 14;
  const L = 44;
  const top = niceMax(Math.max(...series.map((p) => p.mrr)) * 1.12);
  const xs = (i: number) => L + 10 + (i * (W - L - 20)) / (series.length - 1);
  const ys = (v: number) => B - (v / top) * (B - T);
  const pts = series.map((p, i) => [xs(i), ys(p.mrr)] as [number, number]);
  const line = smooth(pts);
  const area = `${line} L${pts.at(-1)![0].toFixed(1)} ${B} L${pts[0]![0].toFixed(1)} ${B} Z`;
  const ticks = [0, 1, 2, 3, 4].map((i) => ({ y: ys((top * i) / 4), label: shortInr((top * i) / 4) }));
  const hv = hover >= 0 && hover < series.length ? hover : -1;
  const tip = (() => {
    if (hv < 0) return null;
    const p = series[hv]!;
    const before = hv > 0 ? series[hv - 1]!.mrr : a.beforeRange;
    // The change goes through the trend rule, like every change LUME shows: "+₹10" with no "+0.0%".
    const t = trend(p.mrr, before, { kind: "abs", format: inr });
    const pct = trend(p.mrr, before);
    return {
      month: month(p.month, true),
      mrr: inr(p.mrr),
      change:
        t.dir === "flat"
          ? "No change"
          : `${t.text}${pct.dir !== "flat" && before > 0 ? ` (${pct.text})` : ""}`,
      t,
      moves:
        [p.joined ? `${p.joined} joined` : "", p.left ? `${p.left} left` : ""].filter(Boolean).join(" · ") ||
        "No one joined or left",
    };
  })();

  // What moved it.
  const mv = a.moves;
  const steps = [
    { label: "Start", kind: "total", v: mv.start },
    { label: "New", kind: "add", v: mv.new },
    { label: "Price up", kind: "add", v: mv.up },
    ...(mv.down ? [{ label: "Price down", kind: "sub", v: mv.down }] : []),
    { label: "Lost", kind: "sub", v: mv.lost },
    { label: "Now", kind: "total", v: mv.now },
  ] as const;
  const peak = niceMax(Math.max(mv.start + mv.new + mv.up, mv.now) * 1.08);
  const px = (v: number) => (v / peak) * 186;
  let run = 0;
  const bars = steps.map((m, i) => {
    let bottom: number;
    let h: number;
    if (m.kind === "total") {
      bottom = 0;
      h = px(m.v);
      run = m.v;
    } else if (m.kind === "add") {
      bottom = px(run);
      h = px(m.v);
      run += m.v;
    } else {
      run -= m.v;
      bottom = px(run);
      h = px(m.v);
    }
    const plain = m.kind === "total" || Math.round(m.v) === 0;
    return {
      ...m,
      bottom,
      h: Math.max(2, h),
      value: `${plain ? "" : m.kind === "add" ? "+" : MINUS}${shortInr(m.v)}`,
      ink: plain ? "var(--ink)" : m.kind === "add" ? "var(--greenInk)" : "var(--redInk)",
      arrow: plain ? null : ARROWS[m.kind === "add" ? "up" : "down"],
      color:
        m.kind === "total"
          ? i === 0
            ? "var(--startBar)"
            : "#2a5bff"
          : m.kind === "add"
            ? "#18a566"
            : "#e5484d",
    };
  });

  const smalls: {
    label: string;
    value: string;
    trend: Trend | null;
    note: string;
    tone: string;
    icon: string;
  }[] = [
    {
      label: "Average per client",
      value: inr(a.arpa),
      trend: trend(a.arpa, a.arpaBefore, { vs }),
      note: "a month, across paying clients",
      tone: "tone-blue",
      icon: "M2.5 13.5h11M4.5 11V7M8 11V3.5M11.5 11V6",
    },
    {
      label: "Lifetime value",
      value: a.ltv ? (a.ltv >= 100000 ? `₹${(a.ltv / 100000).toFixed(2)} L` : inr(a.ltv)) : "No one lost yet",
      trend: a.ltv && a.ltvBefore ? trend(a.ltv, a.ltvBefore, { vs }) : null,
      note: a.ltv ? "what a client is worth, at this churn" : "in this period",
      tone: "tone-violet",
      icon: "M8 14s-5.5-3.2-5.5-7.2A3 3 0 018 5a3 3 0 015.5 1.8C13.5 10.8 8 14 8 14z",
    },
    {
      label: "Clients lost",
      value: `${(a.churn * 100).toFixed(1)}%`,
      trend: trend(a.churn, a.churnBefore, { kind: "pts", good: "down", vs }),
      note: `a month, over the last ${range} months`,
      tone: "tone-red",
      icon: "M2.5 4.5l4 4 3-3 4 5M10.5 10.5h3v-3",
    },
    {
      label: "Trial to paid",
      value:
        a.trials.started - a.trials.running > 0
          ? `${Math.round(a.trials.rate * 100)}%`
          : a.trials.started
            ? "—"
            : "No trials yet",
      trend:
        a.trials.started - a.trials.running > 0
          ? trend(a.trials.rate, a.trials.rateBefore, { kind: "pts", vs })
          : null,
      note:
        a.trials.started - a.trials.running > 0
          ? `${a.trials.bought} of ${a.trials.started - a.trials.running} finished trials bought LUME`
          : a.trials.running
            ? `${a.trials.running} ${a.trials.running === 1 ? "trial is" : "trials are"} running; none has finished yet`
            : "Trials show here once they end",
      tone: "tone-green",
      icon: "M3 8.5l3 3 7-7",
    },
  ];

  const countries = who === "all" ? a.countries.all : a.countries.fresh;
  const states = who === "all" ? a.states.all : a.states.fresh;
  const cMax = Math.max(1, ...countries.map((c) => c.clients));
  const sMax = Math.max(1, ...states.map((s) => s.clients));
  const nClients = countries.reduce((t, c) => t + c.clients, 0);
  const C = 402.12;
  let acc = 0;
  const arcs = a.currencies.map((x, i) => {
    const len = a.mrr ? (x.mrrInr / a.mrr) * C : 0;
    const arc = {
      cur: x.currency,
      color: CUR_COLOR[x.currency] ?? EXTRA[i % EXTRA.length]!,
      pct: `${a.mrr ? Math.round((x.mrrInr / a.mrr) * 100) : 0}%`,
      dash: `${Math.max(0, len - 2).toFixed(2)} ${C}`,
      offset: (-acc).toFixed(2),
    };
    acc += len;
    return arc;
  });
  const srcMax = Math.max(1, ...a.sources.map((s) => s.mrrInr));
  const hi = niceMax((a.spread.at(-1)?.mrrInr ?? a.listPriceInr) * 1.05 || 1);
  const xOf = (v: number) => Math.min(100, (v / hi) * 100);
  // Dots that would touch take the next lane (above, below, further out), like the canvas's spread.
  const laneEnds: number[] = [];
  const dots = a.spread.map((p) => {
    const x = xOf(p.mrrInr);
    let k = 0;
    while (laneEnds[k] !== undefined && x - laneEnds[k]! < 4.5) k++;
    laneEnds[k] = x;
    return {
      ...p,
      dy: k === 0 ? 0 : k % 2 ? -16 * Math.ceil(k / 2) : 16 * Math.ceil(k / 2),
      low: a.listPriceInr > 0 && p.mrrInr < a.listPriceInr - 0.5,
    };
  });
  const sp = spot >= 0 ? dots[spot] : null;
  const ratesUsed = a.currencies
    .filter((x) => x.currency !== "INR")
    .map((x) => `1 ${x.currency} = ₹${(a.rates.rates[x.currency] ?? 0).toFixed(2)}`);

  return (
    <>
      {head}
      <div className="body">
        {a.missingRates.length > 0 && (
          <p
            role="status"
            className="preview"
            style={{ margin: 0, background: "var(--amberBg)", color: "var(--amberInk)" }}
          >
            No exchange rate yet for {a.missingRates.join(", ")}. Clients paying in{" "}
            {a.missingRates.length === 1 ? "it" : "them"} are left out of the rupee totals until there is one.
          </p>
        )}
        <div
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}
        >
          <section className="card hero blue" aria-label="Monthly revenue" style={{ gap: 10 }}>
            <h2 className="h">Monthly revenue</h2>
            <span className="big">{inr(a.mrr)}</span>
            <Delta t={trend(a.mrr, a.mrrBefore, { vs })} />
            <Spark values={series.slice(-7).map((p) => p.mrr)} />
          </section>
          <section className="card" aria-label="Yearly run rate" style={{ gap: 10, animationDelay: ".05s" }}>
            <h2 className="h">Yearly run rate</h2>
            <span className="big">{inr(a.arr)}</span>
            <Delta t={trend(a.arr, a.mrrBefore * 12, { kind: "abs", format: shortInr, vs })} />
            <span className="note">This month&apos;s revenue, for 12 months</span>
          </section>
          <section className="card" aria-label="Paying clients" style={{ gap: 10, animationDelay: ".1s" }}>
            <h2 className="h">Paying clients</h2>
            <span className="big">{a.paying}</span>
            <Delta t={trend(a.paying, a.payingBefore, { kind: "abs", vs })} />
            <span className="note">
              {a.joined} joined · {a.left} left this month
            </span>
          </section>
          <section
            className={`card${gTone === "flat" ? "" : ` hero ${gTone}`}`}
            aria-label="Monthly growth"
            style={{ gap: 10, animationDelay: ".15s" }}
          >
            <h2 className="h">Monthly growth</h2>
            <span className="big">
              {g > 0 ? "+" : g < 0 ? MINUS : ""}
              {Math.abs(g).toFixed(1)}%
            </span>
            <span className="note" style={{ maxWidth: 170 }}>
              a month on average, over{" "}
              {months === range
                ? `the last ${range} months`
                : `${months} ${months === 1 ? "month" : "months"} with revenue`}
            </span>
            {gTone !== "flat" && (
              <svg
                className="jag"
                width="58"
                height="58"
                viewBox="0 0 16 16"
                fill="none"
                stroke="#fff"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d={ARROWS[g > 0 ? "up" : "down"]} />
              </svg>
            )}
          </section>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)", gap: 14 }}>
          <section className="card" aria-label="Monthly revenue over time" style={{ animationDelay: ".12s" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
              <h2 className="h">Monthly revenue over time</h2>
              <span className="note">Hover a month</span>
            </div>
            <div style={{ position: "relative", height: 262 }} onMouseLeave={() => setHover(-1)}>
              <svg
                width="100%"
                height="236"
                viewBox={`0 0 ${W} 236`}
                preserveAspectRatio="none"
                style={{ display: "block", overflow: "visible" }}
                role="img"
                aria-label={`Monthly revenue from ${month(series[0]!.month, true)} to ${month(series.at(-1)!.month, true)}: ${inr(series[0]!.mrr)} to ${inr(a.mrr)}`}
              >
                <defs>
                  <linearGradient id="mrrFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#2a5bff" stopOpacity=".28" />
                    <stop offset="1" stopColor="#2a5bff" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path
                  d={ticks.map((t) => `M44 ${t.y.toFixed(1)}H${W}`).join(" ")}
                  stroke="var(--grid)"
                  strokeWidth="1"
                  fill="none"
                />
                <path key={`f${gen}`} className="chart-fill" d={area} fill="url(#mrrFill)" />
                <path key={`l${gen}`} className="chart-line" pathLength={1} d={line} />
              </svg>
              {ticks.map((t) => (
                <span
                  key={t.y}
                  className="num"
                  style={{
                    position: "absolute",
                    left: 0,
                    top: t.y,
                    transform: "translateY(-50%)",
                    fontSize: 11,
                    color: "var(--ink3)",
                  }}
                >
                  {t.label}
                </span>
              ))}
              {hv >= 0 && (
                <>
                  <span
                    style={{
                      position: "absolute",
                      left: `${(pts[hv]![0] / W) * 100}%`,
                      top: 8,
                      height: 208,
                      borderLeft: "1px dashed var(--line2)",
                      pointerEvents: "none",
                    }}
                    aria-hidden
                  />
                  <span
                    className="hdot"
                    style={{ left: `${(pts[hv]![0] / W) * 100}%`, top: pts[hv]![1] }}
                    aria-hidden
                  />
                </>
              )}
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 18,
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "0 10px 0 54px",
                  fontSize: 11.5,
                  color: "var(--ink3)",
                }}
                aria-hidden
              >
                {series.map((p, i) => (
                  <span
                    key={p.month}
                    style={{
                      width: 0,
                      display: "flex",
                      justifyContent: "center",
                      whiteSpace: "nowrap",
                      fontWeight: i === hv ? 700 : 500,
                      color: i === hv ? "var(--ink)" : undefined,
                    }}
                  >
                    {p.month.endsWith("-01") ? `${month(p.month)} '${p.month.slice(2, 4)}` : month(p.month)}
                  </span>
                ))}
              </div>
              <div
                style={{
                  position: "absolute",
                  left: 44,
                  right: 0,
                  top: 0,
                  height: 236,
                  display: "flex",
                  zIndex: 1,
                }}
              >
                {series.map((p, i) => (
                  <span
                    key={p.month}
                    data-month={p.month}
                    onMouseEnter={() => setHover(i)}
                    style={{ flex: 1, height: "100%" }}
                    aria-hidden
                  />
                ))}
              </div>
              {tip && (
                <div className="tip" style={{ left: `${(pts[hv]![0] / W) * 100}%`, top: pts[hv]![1] }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink3)" }}>{tip.month}</span>
                  <span className="num" style={{ fontSize: 16, fontWeight: 700 }}>
                    {tip.mrr}
                  </span>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      color: TONE_INK[tip.t.tone],
                      fontWeight: 600,
                    }}
                  >
                    {tip.t.dir !== "flat" && (
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.9"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d={ARROWS[tip.t.dir]} />
                      </svg>
                    )}
                    {tip.change}
                  </span>
                  <span style={{ color: "var(--ink2)" }}>{tip.moves}</span>
                </div>
              )}
            </div>
          </section>

          <section className="card" aria-label="What moved it" style={{ animationDelay: ".18s" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
              <h2 className="h">What moved it</h2>
              <span className="note">the last {range} months</span>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                justifyContent: "space-between",
                height: 214,
                padding: "0 4px",
                borderBottom: "1px solid var(--grid)",
              }}
            >
              {bars.map((m, i) => (
                <div key={m.label} style={{ position: "relative", width: 48, height: "100%" }}>
                  <span
                    className="num"
                    style={{
                      position: "absolute",
                      left: "50%",
                      bottom: m.bottom + m.h + 6,
                      transform: "translateX(-50%)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 2,
                      fontSize: 11.5,
                      fontWeight: 700,
                      whiteSpace: "nowrap",
                      color: m.ink,
                    }}
                  >
                    {m.arrow && (
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d={m.arrow} />
                      </svg>
                    )}
                    {m.value}
                  </span>
                  <span
                    className="vbar"
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      bottom: m.bottom,
                      height: m.h,
                      background: m.color,
                      animationDelay: `${(0.2 + i * 0.09).toFixed(2)}s`,
                    }}
                    aria-hidden
                  />
                </div>
              ))}
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "0 4px",
                fontSize: 11.5,
                fontWeight: 600,
                color: "var(--ink3)",
              }}
            >
              {bars.map((m) => (
                <span key={m.label} style={{ width: 48, textAlign: "center" }}>
                  {m.label}
                </span>
              ))}
            </div>
          </section>
        </div>

        <div
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}
        >
          {smalls.map((k, i) => (
            <section
              key={k.label}
              className="card"
              aria-label={k.label}
              style={{ gap: 8, padding: "18px 20px", animationDelay: `${(0.08 + i * 0.05).toFixed(2)}s` }}
            >
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: "var(--ink2)",
                }}
              >
                <span
                  className={`ico toned ${k.tone}`}
                  style={{ width: 24, height: 24, borderRadius: 7 }}
                  aria-hidden
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d={k.icon} />
                  </svg>
                </span>
                {k.label}
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span className="num" style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-.02em" }}>
                  {k.value}
                </span>
                {k.trend && <Delta t={k.trend} />}
              </span>
              <span className="note">{k.note}</span>
            </section>
          ))}
        </div>

        <div
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}
        >
          <section className="card" aria-label="Clients by country">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h2 className="h">Clients by country</h2>
              <div
                className="seg"
                role="radiogroup"
                aria-label="Which clients"
                style={{ width: 128, padding: 2 }}
              >
                <span
                  className="segpill"
                  style={{
                    top: 2,
                    left: 2,
                    height: 26,
                    width: 62,
                    transform: `translateX(${who === "all" ? 0 : 62}px)`,
                  }}
                  aria-hidden
                />
                <button
                  type="button"
                  role="radio"
                  aria-checked={who === "all"}
                  onClick={() => setWho("all")}
                  style={{ width: 62, height: 26, fontSize: 12 }}
                >
                  All
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={who === "fresh"}
                  onClick={() => setWho("fresh")}
                  style={{ width: 62, height: 26, fontSize: 12 }}
                >
                  New
                </button>
              </div>
            </div>
            <span className="note" style={{ marginTop: -6 }}>
              {who === "all"
                ? `${nClients} clients in ${countries.length} ${countries.length === 1 ? "country" : "countries"}`
                : nClients
                  ? `${nClients} joined in the last ${range} months, from ${countries.length} ${countries.length === 1 ? "country" : "countries"}`
                  : ""}
            </span>
            {countries.map((c, i) => (
              <div
                key={c.country}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 7,
                  animation: "rise .5s cubic-bezier(.2,.9,.25,1) both",
                  animationDelay: `${(0.05 + i * 0.05).toFixed(2)}s`,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13.5 }}>
                  <Flag country={c.country} decorative />
                  <span style={{ flexGrow: 1, fontWeight: 600 }}>{countryName(c.country)}</span>
                  <span className="num" style={{ color: "var(--ink3)", fontSize: 12.5 }}>
                    {c.mrrInr ? inr(c.mrrInr) : "no monthly revenue"}
                  </span>
                  <span
                    className="num"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "flex-end",
                      gap: 3,
                      minWidth: 22,
                      fontWeight: 700,
                      color: who === "fresh" ? "var(--greenInk)" : "var(--ink)",
                    }}
                  >
                    {who === "fresh" && (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d={ARROWS.up} />
                      </svg>
                    )}
                    {who === "fresh" ? `+${c.clients}` : c.clients}
                  </span>
                </div>
                <div className="track">
                  <div
                    className="hbar"
                    style={{
                      width: `${((c.clients / cMax) * 100).toFixed(1)}%`,
                      animationDelay: `${(0.05 + i * 0.05).toFixed(2)}s`,
                    }}
                  />
                </div>
              </div>
            ))}
            {countries.length === 0 && (
              <p className="note" style={{ margin: 0, fontSize: 13.5 }}>
                No new clients in this period.
              </p>
            )}
          </section>

          <section className="card" aria-label="India by state">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Flag country="IN" decorative />
              <h2 className="h">India by state</h2>
            </div>
            <span className="note" style={{ marginTop: -6 }}>
              {states.length
                ? `${states.reduce((t, s) => t + s.clients, 0)} clients across ${states.length} ${states.length === 1 ? "state" : "states"}`
                : ""}
            </span>
            {states.map((s, i) => (
              <div key={s.region} style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13.5 }}>
                <span style={{ width: 110, flexShrink: 0, fontWeight: 600 }}>
                  {INDIA_STATES[s.region] ?? s.region}
                </span>
                <div className="track" style={{ flexGrow: 1, height: 22, borderRadius: 7 }}>
                  <div
                    className="hbar"
                    style={{
                      height: 22,
                      borderRadius: 7,
                      width: `${((s.clients / sMax) * 100).toFixed(1)}%`,
                      background: "linear-gradient(90deg, #2a5bff, #5b82ff)",
                      animationDelay: `${(0.05 + i * 0.06).toFixed(2)}s`,
                    }}
                  />
                </div>
                <span className="num" style={{ width: 18, textAlign: "right", fontWeight: 700 }}>
                  {s.clients}
                </span>
              </div>
            ))}
            {states.length === 0 && (
              <p className="note" style={{ margin: 0, fontSize: 13.5 }}>
                No {who === "fresh" ? "new " : ""}clients in India in this period.
              </p>
            )}
          </section>

          <section className="card" aria-label="Revenue by currency">
            <h2 className="h">Revenue by currency</h2>
            <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
              <div style={{ position: "relative", width: 150, height: 150, flexShrink: 0 }} aria-hidden>
                {arcs.map((x) => (
                  <svg
                    key={x.cur}
                    width="150"
                    height="150"
                    viewBox="0 0 150 150"
                    style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }}
                  >
                    <circle
                      cx="75"
                      cy="75"
                      r="64"
                      fill="none"
                      stroke={x.color}
                      strokeWidth="18"
                      strokeDasharray={x.dash}
                      strokeDashoffset={x.offset}
                    />
                  </svg>
                ))}
                <svg
                  width="150"
                  height="150"
                  viewBox="0 0 150 150"
                  style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }}
                >
                  <circle
                    className="sweep"
                    cx="75"
                    cy="75"
                    r="64"
                    fill="none"
                    stroke="var(--card)"
                    strokeWidth="20"
                    strokeDasharray="402.12 402.12"
                    strokeDashoffset="0"
                  />
                </svg>
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 2,
                  }}
                >
                  <span style={{ fontSize: 11, fontWeight: 600, color: "var(--ink3)" }}>from abroad</span>
                  <span className="num" style={{ fontSize: 20, fontWeight: 700 }}>
                    {a.mrr ? Math.round((a.abroadInr / a.mrr) * 100) : 0}%
                  </span>
                </div>
              </div>
              <ul
                style={{
                  flexGrow: 1,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  margin: 0,
                  padding: 0,
                  listStyle: "none",
                }}
              >
                {arcs.map((x) => (
                  <li key={x.cur} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                    <span style={{ width: 9, height: 9, borderRadius: 3, background: x.color }} aria-hidden />
                    <span style={{ flexGrow: 1, fontWeight: 600 }}>{x.cur}</span>
                    <span className="num" style={{ color: "var(--ink2)" }}>
                      {x.pct}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {ratesUsed.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {ratesUsed.map((r) => (
                  <span
                    key={r}
                    className="num"
                    style={{
                      height: 24,
                      padding: "0 9px",
                      borderRadius: 999,
                      background: "var(--sunk)",
                      boxShadow: "inset 0 0 0 .5px var(--line)",
                      fontSize: 11.5,
                      fontWeight: 500,
                      color: "var(--ink2)",
                      display: "inline-flex",
                      alignItems: "center",
                    }}
                  >
                    {r}
                  </span>
                ))}
              </div>
            )}
            <span style={{ fontSize: 12, color: "var(--ink3)" }}>
              {a.rates.day === null
                ? "No exchange rates yet: LUME fetches them once a day."
                : a.rates.ageDays
                  ? `Rates from ${a.rates.ageDays} ${a.rates.ageDays === 1 ? "day" : "days"} ago (the rate service hasn't answered since). A payment keeps the rate of the day it was marked paid.`
                  : "Rates updated today. A payment keeps the rate of the day it was marked paid."}
            </span>
          </section>
        </div>

        <div
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}
        >
          <section className="card" aria-label="Where clients come from">
            <h2 className="h">Where clients come from</h2>
            {a.sources.map((s, i) => (
              <div key={s.source} style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 13.5 }}>
                  <span style={{ flexGrow: 1, fontWeight: 600 }}>{SOURCE_WORDS[s.source]}</span>
                  <span className="num" style={{ fontWeight: 700 }}>
                    {inr(s.mrrInr)}
                  </span>
                </div>
                <div className="track">
                  <div
                    className="hbar"
                    style={{
                      width: `${((s.mrrInr / srcMax) * 100).toFixed(1)}%`,
                      background: ["#2a5bff", "#5b82ff", "#8aa7ff", "#b3c6ff"][i] ?? "#b3c6ff",
                      animationDelay: `${(0.1 + i * 0.07).toFixed(2)}s`,
                    }}
                  />
                </div>
                <span style={{ fontSize: 12, color: "var(--ink3)" }}>
                  {s.clients} {s.clients === 1 ? "client" : "clients"}
                  {s.paying ? ` · ${inr(s.mrrInr / s.paying)} each on average` : " · trials so far"}
                </span>
              </div>
            ))}
          </section>

          <section className="card" aria-label="What each client pays">
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
              <h2 className="h">What each client pays</h2>
              <span className="note">a month, in ₹</span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span className="num" style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-.02em" }}>
                {a.belowList}
              </span>
              <span style={{ fontSize: 13, color: "var(--ink2)" }}>
                of {a.spread.length} pay below your list price
              </span>
            </div>
            <div style={{ position: "relative", height: 96, margin: "8px 8px 0" }}>
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: 48,
                  height: 2,
                  borderRadius: 1,
                  background: "var(--sunk)",
                }}
              />
              {a.listPriceInr > 0 && (
                <>
                  <div
                    style={{
                      position: "absolute",
                      left: `${xOf(a.listPriceInr)}%`,
                      top: 14,
                      bottom: 14,
                      width: 0,
                      borderLeft: "1.5px dashed var(--ink3)",
                    }}
                  />
                  <span
                    style={{
                      position: "absolute",
                      left: `${xOf(a.listPriceInr)}%`,
                      top: -6,
                      transform: "translateX(-50%)",
                      fontSize: 11,
                      fontWeight: 600,
                      color: "var(--ink2)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    List {inr(a.listPriceInr)}
                  </span>
                </>
              )}
              {dots.map((p, i) => (
                <span
                  key={p.id}
                  className={`pdot${p.low ? " lo" : ""}`}
                  role="img"
                  tabIndex={0}
                  aria-label={`${p.name}: ${inr(p.mrrInr)} a month`}
                  onMouseEnter={() => setSpot(i)}
                  onMouseLeave={() => setSpot(-1)}
                  onFocus={() => setSpot(i)}
                  onBlur={() => setSpot(-1)}
                  style={{
                    left: `${xOf(p.mrrInr)}%`,
                    top: `calc(50% + ${p.dy}px)`,
                    animationDelay: `${(0.3 + i * 0.05).toFixed(2)}s`,
                  }}
                />
              ))}
              {sp && (
                <span className="tip" style={{ left: `${xOf(sp.mrrInr)}%`, top: 40 }}>
                  <strong style={{ fontWeight: 600 }}>{sp.name}</strong>
                  <span className="num" style={{ color: "var(--ink2)" }}>
                    {inr(sp.mrrInr)} a month
                  </span>
                </span>
              )}
            </div>
            <div
              className="num"
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 11.5,
                color: "var(--ink3)",
                margin: "0 8px",
              }}
            >
              <span>₹0</span>
              <span>{inr(hi)}</span>
            </div>
            <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--ink2)" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{ width: 9, height: 9, borderRadius: "50%", background: "#2a5bff" }}
                  aria-hidden
                />
                At or above list
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{ width: 9, height: 9, borderRadius: "50%", background: "#f2a20c" }}
                  aria-hidden
                />
                Below list
              </span>
            </div>
          </section>

          <section className="card" aria-label="Ideas to grow">
            <h2 className="h">Ideas to grow</h2>
            {a.ideas.map((x, i) => (
              <div
                key={x.key}
                className={`ins ${IDEA_LOOK[x.key]!.tone}`}
                style={{ animationDelay: `${(0.35 + i * 0.08).toFixed(2)}s` }}
              >
                <span className="ico toned" aria-hidden>
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d={IDEA_LOOK[x.key]!.icon} />
                  </svg>
                </span>
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 13, lineHeight: 1.45 }}
                >
                  <strong style={{ fontWeight: 600 }}>{x.title}</strong>
                  <span style={{ color: "var(--ink2)" }}>{x.body}</span>
                </div>
              </div>
            ))}
            {a.ideas.length === 0 && (
              <p className="note" style={{ margin: 0, fontSize: 13.5 }}>
                Ideas appear once clients are paying.
              </p>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

/** The last seven months, as a small white line on the blue card. */
function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pts = values.map(
    (v, i) =>
      [(i * 120) / (values.length - 1), 40 - ((v - lo) / Math.max(1, hi - lo)) * 34] as [number, number],
  );
  const line = smooth(pts);
  return (
    <svg
      width="120"
      height="44"
      viewBox="0 0 120 44"
      style={{ position: "absolute", right: 18, bottom: 18 }}
      aria-hidden
    >
      <path d={`${line} L120 44 L0 44 Z`} fill="rgba(255,255,255,.16)" />
      <path d={line} fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
