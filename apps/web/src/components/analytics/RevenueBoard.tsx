"use client";
import Link from "next/link";
import { useState, type CSSProperties } from "react";
import type { Revenue, Sources } from "@/lib/analytics/client";
import { niceTicks, smooth } from "@/lib/analytics/chart";
import { count, money, pct } from "@/lib/analytics/words";
import type { Catalog } from "@/lib/leads/types";
import { Card, Chip, Skeleton } from "./parts";
import a from "./analytics.module.css";
import s from "./revenue.module.css";
import { roving } from "@/lib/roving";

/** Settings → Sources & spend (8D-3), where an admin sets what each source costs a month. */
export const SPEND_HREF = "/settings/sources";
const KIND: Record<string, string> = {
  csv: "File import",
  google_sheet: "Google Sheet",
  webhook: "Webhook",
  manual: "Added by hand",
};
const SLICE = ["#2a5bff", "#5ab8ff", "#18a566", "#f2a20c", "#e5484d", "#8a94a6"];
const W = 700;
const H = 226;

/**
 * Revenue & sources (canvas Revenue): this month against its goal, or the last twelve months; the money by package;
 * and what each source brought and cost. Someone without analytics.revenue sees the sources' leads and wins only.
 */
export function RevenueBoard({
  revenue,
  sources,
  catalog,
  compare,
  rangeWords,
  canEditSpend,
  onDrill,
}: {
  /** undefined: not allowed to see money. null: loading. */
  revenue: Revenue | null | undefined;
  sources: Sources | null;
  catalog: Catalog;
  compare: boolean;
  rangeWords: string;
  canEditSpend: boolean;
  onDrill(token: string, title: string): void;
}) {
  const currency = catalog.currency;
  return (
    <>
      {revenue !== undefined && (
        <div className={s.rg}>
          {revenue === null ? (
            <>
              <Skeleton h={340} />
              <Skeleton h={340} i={1} />
            </>
          ) : (
            <>
              <GoalChart revenue={revenue} currency={currency} compare={compare} onDrill={onDrill} />
              <ByPackage revenue={revenue} currency={currency} rangeWords={rangeWords} onDrill={onDrill} />
            </>
          )}
        </div>
      )}
      <SourcesTable
        sources={sources}
        catalog={catalog}
        rangeWords={rangeWords}
        money_={revenue !== undefined}
        canEditSpend={canEditSpend}
        spaced={revenue !== undefined}
      />
    </>
  );
}

const dayWords = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const monthOf = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });

function GoalChart({
  revenue,
  currency,
  compare,
  onDrill,
}: {
  revenue: Revenue;
  currency: string;
  compare: boolean;
  onDrill(token: string, title: string): void;
}) {
  const [view, setView] = useState<"goal" | "month">("goal");
  const [hi, setHi] = useState<number | null>(null);
  const m = revenue.thisMonth;
  const months = revenue.byMonth;
  const goalView = view === "goal" || !months;
  const soFar = m.cumulative.at(-1) ?? 0;
  const n = m.daysInMonth;
  // x: the month's days, 1 to n; y: money, to a round top above the goal, the pace and what's won.
  const ticks = niceTicks(
    goalView ? Math.max(1, soFar, m.goal ?? 0, m.paceEnd ?? 0) : Math.max(1, ...months!.map((x) => x.value)),
  );
  const top = ticks.at(-1)!;
  const xOf = (day: number) => 6 + ((day - 1) / Math.max(1, n - 1)) * (W - 12);
  const yOf = (v: number) => 8 + (1 - v / top) * (H - 12);
  const today = m.days.length;
  const pts = m.cumulative.map((v, i) => [xOf(i + 1), yOf(v)] as [number, number]);
  const line = smooth(pts);
  const monthName = monthOf(m.today);
  const paceTone = m.paceEnd === null || m.goal === null ? "flat" : m.paceEnd >= m.goal ? "good" : "bad";
  const total12 = months?.reduce((x, y) => x + y.value, 0) ?? 0;
  const bw = (W - 20) / 12 - 14;
  return (
    <Card
      title={goalView ? `${monthName}, against the goal` : "Revenue won, month by month"}
      sub={
        goalView
          ? "Won so far, and where this pace would end the month"
          : `The last 12 months; ${monthName} so far`
      }
      right={
        months ? (
          <span className={s.seg} role="radiogroup" aria-label="Show" onKeyDown={(e) => roving(e, "radio")}>
            <button
              type="button"
              role="radio"
              aria-checked={goalView}
              tabIndex={goalView ? 0 : -1}
              onClick={() => setView("goal")}
            >
              This month
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!goalView}
              tabIndex={goalView ? -1 : 0}
              onClick={() => setView("month")}
            >
              By month
            </button>
          </span>
        ) : undefined
      }
    >
      <div className={s.big}>
        <b>{money(goalView ? soFar : total12, currency, !goalView)}</b>
        {goalView && m.paceEnd !== null && (
          <span className={a.chip} data-tone={paceTone}>
            On pace for {money(m.paceEnd, currency)}
          </span>
        )}
        {!goalView && compare && revenue.trend && <Chip trend={revenue.trend} />}
        <span>
          {goalView
            ? `${m.goal !== null ? `of ${money(m.goal, currency)} · ` : "No goal set · "}${today} ${today === 1 ? "day" : "days"} in`
            : "over the last 12 months"}
        </span>
      </div>
      <div className={s.chart}>
        <svg viewBox={`0 0 ${W} 250`} preserveAspectRatio="none" role="img" aria-label="Revenue won">
          <defs>
            <linearGradient id="revfill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#2a5bff" stopOpacity=".32" />
              <stop offset="1" stopColor="#2a5bff" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="barfill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#5ab8ff" />
              <stop offset="1" stopColor="#2a5bff" />
            </linearGradient>
          </defs>
          {ticks.slice(1).map((v) => (
            <g key={v}>
              <line className={a.gridLine} x1="0" x2={W} y1={yOf(v)} y2={yOf(v)} />
              <text className={a.axis} x="0" y={yOf(v) - 4}>
                {money(v, currency)}
              </text>
            </g>
          ))}
          {goalView ? (
            <>
              {m.goal !== null && (
                <>
                  <path className={s.goalln} d={`M${xOf(1)},${yOf(0)} L${xOf(n)},${yOf(m.goal)}`} />
                  <text className={s.goaltag} x={W - 6} y={yOf(m.goal) - 6} textAnchor="end">
                    Goal {money(m.goal, currency)}
                  </text>
                </>
              )}
              {pts.length > 1 && (
                <>
                  <path d={`${line} L${xOf(today)},${H} L${xOf(1)},${H} Z`} fill="url(#revfill)" />
                  <path className={s.ln} d={line} />
                </>
              )}
              {m.paceEnd !== null && today < n && (
                <path className={s.paceln} d={`M${xOf(today)},${yOf(soFar)} L${xOf(n)},${yOf(m.paceEnd)}`} />
              )}
              <line className={s.today} x1={xOf(today)} x2={xOf(today)} y1="10" y2={H} />
              <text className={s.todaytag} x={xOf(today)} y="8" textAnchor="middle">
                Today
              </text>
              {hi !== null && <circle className={s.dot} cx={pts[hi]![0]} cy={pts[hi]![1]} r="4" />}
              {[1, 8, 15, 22, 29]
                .filter((d) => d <= n)
                .map((d) => (
                  <text key={d} className={a.axis} x={xOf(d)} y="246" textAnchor="middle">
                    {`${dayWords(m.today).split(" ")[0]} ${d}`}
                  </text>
                ))}
            </>
          ) : (
            months!.map((x, i) => {
              const h = (x.value / top) * (H - 12);
              const cx = 10 + i * ((W - 20) / 12) + 7;
              return (
                <g key={x.month}>
                  <rect
                    className={s.mbar}
                    x={cx}
                    y={H + 4 - h}
                    width={bw}
                    height={h}
                    rx="6"
                    fill={i === 11 ? "rgba(42,91,255,.35)" : "url(#barfill)"}
                    style={{ "--i": i } as CSSProperties}
                  />
                  <text className={a.axis} x={cx + bw / 2} y="246" textAnchor="middle">
                    {x.label.slice(0, 3)}
                  </text>
                </g>
              );
            })
          )}
        </svg>
        {goalView && pts.length > 0 && (
          <button
            type="button"
            className={s.hit}
            aria-label={`Revenue won this month: ${money(soFar, currency)}. See the leads.`}
            disabled={!revenue.drill}
            onPointerMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const day = Math.round(((e.clientX - r.left) / r.width) * (n - 1));
              setHi(day < today ? Math.max(0, day) : null);
            }}
            onPointerLeave={() => setHi(null)}
            onClick={() => revenue.drill && onDrill(revenue.drill, "Revenue won")}
          />
        )}
        {hi !== null && (
          <div
            className={a.tip}
            style={{
              left: `clamp(0px, calc(${(hi / Math.max(1, n - 1)) * 100}% - 84px), calc(100% - 180px))`,
            }}
          >
            <b>{dayWords(m.days[hi]!)}</b>
            <div className={a.tipRow}>
              <span>Won so far</span>
              <em>{money(m.cumulative[hi]!, currency)}</em>
            </div>
            <div className={s.tipHint}>Click to see these leads</div>
          </div>
        )}
        <table className={s.srOnly}>
          <caption>{goalView ? "Revenue won so far, by day" : "Revenue won by month"}</caption>
          <tbody>
            {goalView
              ? m.days.map((d, i) => (
                  <tr key={d}>
                    <th scope="row">{dayWords(d)}</th>
                    <td>{money(m.cumulative[i]!, currency, false)}</td>
                  </tr>
                ))
              : months!.map((x) => (
                  <tr key={x.month}>
                    <th scope="row">{x.label}</th>
                    <td>{money(x.value, currency, false)}</td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ByPackage({
  revenue,
  currency,
  rangeWords,
  onDrill,
}: {
  revenue: Revenue;
  currency: string;
  rangeWords: string;
  onDrill(token: string, title: string): void;
}) {
  const [hot, setHot] = useState<number | null>(null);
  const items = revenue.byProduct.filter((p) => p.value > 0);
  const total = items.reduce((x, p) => x + p.value, 0);
  const C = 2 * Math.PI * 80;
  let at = 0;
  const slices = items.map((p, i) => {
    const len = (p.value / (total || 1)) * C;
    const sl = { len, off: -at, color: SLICE[i % SLICE.length]! };
    at += len;
    return sl;
  });
  const f = revenue.fact;
  return (
    <Card title="By package" sub={`Revenue won ${rangeWords}`}>
      {!items.length ? (
        <p className={a.empty}>Nothing won with a value {rangeWords}.</p>
      ) : (
        <div className={s.dn}>
          <div className={s.dnw}>
            <svg viewBox="0 0 190 190" aria-hidden>
              <circle cx="95" cy="95" r="80" className={s.track} />
              {slices.map((sl, i) => (
                <circle
                  key={i}
                  cx="95"
                  cy="95"
                  r="80"
                  className={s.sl}
                  data-hot={hot === i || undefined}
                  data-dim={(hot !== null && hot !== i) || undefined}
                  stroke={sl.color}
                  strokeDasharray={`${Math.max(0, sl.len - (slices.length > 1 ? 2 : 0))} ${C}`}
                  strokeDashoffset={sl.off}
                  style={{ "--i": i } as CSSProperties}
                />
              ))}
            </svg>
            <div className={s.ctr}>
              <div>
                <b>{money(hot === null ? total : items[hot]!.value, currency)}</b>
                <span>
                  {hot === null ? "won in all" : `${items[hot]!.name} · ${pct(items[hot]!.share ?? 0)}`}
                </span>
              </div>
            </div>
          </div>
          <div className={s.dl}>
            {items.slice(0, 6).map((p, i) => (
              <button
                key={p.id ?? "none"}
                type="button"
                data-hot={hot === i || undefined}
                disabled={!p.drill}
                onPointerEnter={() => setHot(i)}
                onPointerLeave={() => setHot(null)}
                onFocus={() => setHot(i)}
                onBlur={() => setHot(null)}
                onClick={() => p.drill && onDrill(p.drill, `Won: ${p.name}`)}
              >
                <i style={{ background: SLICE[i % SLICE.length] }} />
                <b>{p.name}</b>
                <em>{money(p.value, currency)}</em>
                <span>
                  {count(p.deals)} {p.deals === 1 ? "deal" : "deals"} · avg{" "}
                  {money(p.value / (p.deals || 1), currency)}
                </span>
                <small>{pct(p.share ?? 0)}</small>
              </button>
            ))}
          </div>
        </div>
      )}
      {f && (
        <div className={s.ins}>
          <span className={s.spk} aria-hidden>
            <img src="/lume-mark.png" alt="" />
          </span>
          <div>
            <b>
              {f.product} is {pct(f.dealShare)} of deals, and {pct(f.revenueShare)} of revenue
            </b>
            <p>Each {f.product} deal brings in more than the average.</p>
          </div>
        </div>
      )}
    </Card>
  );
}

const ab = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

function SourcesTable({
  sources,
  catalog,
  rangeWords,
  money_,
  canEditSpend,
  spaced,
}: {
  sources: Sources | null;
  catalog: Catalog;
  rangeWords: string;
  money_: boolean;
  canEditSpend: boolean;
  spaced: boolean;
}) {
  const currency = catalog.currency;
  if (!sources) return <Skeleton h={300} i={2} />;
  const best = Math.max(0.0001, ...sources.sources.map((x) => (x.tooFew ? 0 : (x.winRate ?? 0))));
  return (
    <section
      className={`${a.card} ${spaced ? s.spaced : ""}`}
      style={{ "--i": 2 } as CSSProperties}
      aria-label="Sources"
    >
      <div className={a.cardHead}>
        <div>
          <h3>Sources</h3>
          <div className={a.sub}>
            {money_
              ? `What each source brought ${rangeWords}, and what it cost, where you've entered a monthly spend`
              : `What each source brought ${rangeWords}`}
          </div>
        </div>
      </div>
      {sources.sources.length === 0 ? (
        <p className={a.empty}>No leads arrived {rangeWords}.</p>
      ) : (
        <div className={s.scroll}>
          <table className={s.st}>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Leads</th>
                <th scope="col">Won</th>
                <th scope="col">Conversion</th>
                {money_ && (
                  <>
                    <th scope="col">Revenue won</th>
                    <th scope="col">Spend</th>
                    <th scope="col">Cost per lead</th>
                    <th scope="col">Return on spend</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {sources.sources.map((x, i) => {
                const kind = KIND[catalog.sources.find((c) => c.id === x.id)?.type ?? ""] ?? "In LUME";
                const has = x.spend !== null && x.spend !== undefined && x.spend > 0;
                const roi = x.returnPerSpent ?? null;
                return (
                  <tr key={x.id ?? "none"} style={{ "--i": i } as CSSProperties}>
                    <td>
                      <div className={s.src}>
                        <span className={s.ico} style={{ background: SLICE[i % SLICE.length] }} aria-hidden>
                          {ab(x.name)}
                        </span>
                        <div>
                          <b>{x.name}</b>
                          {x.id && <span>{kind}</span>}
                        </div>
                      </div>
                    </td>
                    <td>{count(x.leads)}</td>
                    <td>{count(x.won)}</td>
                    <td>
                      {x.tooFew ? (
                        <span className={s.cap}>Too few</span>
                      ) : (
                        <span className={s.bw}>
                          {x.winRate === null ? "—" : pct(x.winRate, 1)}
                          <span className={s.tr6}>
                            <i style={{ width: `${((x.winRate ?? 0) / best) * 100}%` }} />
                          </span>
                        </span>
                      )}
                    </td>
                    {money_ && (
                      <>
                        <td>
                          <b>{money(x.revenue ?? 0, currency)}</b>
                        </td>
                        <td>
                          {has ? (
                            money(x.spend!, currency)
                          ) : canEditSpend && x.id ? (
                            <Link className={s.addsp} href={SPEND_HREF}>
                              Add spend
                            </Link>
                          ) : (
                            <span className={s.cap}>Not set</span>
                          )}
                        </td>
                        <td>{has && x.costPerLead != null ? money(x.costPerLead, currency, false) : "—"}</td>
                        <td>
                          {has && roi !== null ? (
                            <span className={s.roi} data-tone={roi >= 3 ? "hi" : roi < 1 ? "lo" : "mid"}>
                              {`${roi.toFixed(1).replace(/\.0$/, "")}×`}
                            </span>
                          ) : (
                            <span className={s.cap}>—</span>
                          )}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {money_ && (
        <p className={s.foot}>
          Spend is each source&rsquo;s monthly amount, counted for the days in this range.
          {canEditSpend && (
            <>
              {" "}
              <Link href={SPEND_HREF}>Set it in Settings → Sources &amp; spend</Link>
            </>
          )}
        </p>
      )}
    </section>
  );
}
