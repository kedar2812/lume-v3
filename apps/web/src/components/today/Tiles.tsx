"use client";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { trend } from "@lume/core/shared";
import { Chip } from "@/components/analytics/parts";
import { avatarColor, initials } from "@/components/ui/Avatar";
import { areaUnder, smooth, sparkLine, toPts } from "@/lib/analytics/chart";
import { count, minutes, money, pct } from "@/lib/analytics/words";
import { addDays } from "@/lib/dates";
import type { Tiles as TilesData } from "@/lib/today/types";
import { sameDaysLastMonth } from "@/lib/today/words";
import s from "./today.module.css";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const monthOf = (day: string) => MONTHS[Number(day.slice(5, 7)) - 1]!;
const weekdayOf = (day: string) => WEEKDAYS[new Date(day + "T12:00:00Z").getUTCDay()]!;
const v = (i: number) => ({ "--i": i }) as CSSProperties;

const I = {
  leads: (
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87" />
  ),
  money: <path d="M6 3h12M6 8h12M6 13l8.5 8M6 13h3a5 5 0 0 0 0-10" />,
  won: <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" />,
  pipeline: (
    <path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 3v18M15 3v18" />
  ),
  calendar: (
    <path d="M8 2v3M16 2v3M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM3 9h18" />
  ),
  team: (
    <path d="M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M2 21v-1a7 7 0 0 1 14 0v1M17 4a4 4 0 0 1 0 8M22 21v-1a7 7 0 0 0-4-6.3" />
  ),
  ontime: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12l3 3 5-6" />,
  replies: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z" />,
};

function Tile({
  href,
  icon,
  label,
  i,
  lit,
  aria,
  children,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  i: number;
  lit?: boolean;
  aria: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={`${s.tl}${lit ? ` ${s.lit}` : ""}`} style={v(i)} aria-label={aria}>
      <div className={s.th}>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          {icon}
        </svg>
        {label}
        <span className={s.arrow} aria-hidden>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M7 17 17 7M8 7h9v9" />
          </svg>
        </span>
      </div>
      {children}
    </Link>
  );
}

/** The number, and what it's set against — said in words beside the chip, never a bare percentage. */
function Big({ value, unit, children }: { value: string; unit?: string; children?: ReactNode }) {
  return (
    <>
      <div className={s.big} data-live-count>
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {children && (
        <div className={s.cmp} data-live-count>
          {children}
        </div>
      )}
    </>
  );
}

export type TilesProps = {
  tiles: TilesData;
  currency: string;
  /** The viewer sees only their own leads (and numbers): "Your leads", "Your pipeline". */
  own: boolean;
  /** Leads with no one yet, for someone who can assign them (from /today). */
  unassigned?: number;
};

/**
 * Today's six tiles (spec: The tiles). Each answers one question with one number counted as it is everywhere else in
 * LUME; a tile the viewer may not see isn't there, and the rest close up.
 */
export function Tiles({ tiles: t, currency, own, unassigned }: TilesProps) {
  const out: ReactNode[] = [];
  let i = 2;
  if (t.leads) out.push(<LeadsTile key="leads" t={t.leads} own={own} unassigned={unassigned} i={i++} />);
  if (t.month) out.push(<MonthTile key="month" t={t.month} own={own} currency={currency} i={i++} />);
  if (t.pipeline)
    out.push(<PipelineTile key="pipeline" t={t.pipeline} own={own} currency={currency} i={i++} />);
  out.push(<CalendarTile key="calendar" t={t.calendar} i={i++} />);
  if (t.team) out.push(<TeamTile key="team" t={t.team} i={i++} />);
  if (t.streak) out.push(<StreakTile key="streak" t={t.streak} i={i++} />);
  if (t.replies) out.push(<RepliesTile key="replies" t={t.replies} own={own} i={i++} />);
  return <>{out}</>;
}

/** Leads: are they coming in as usual today? */
function LeadsTile({
  t,
  own,
  unassigned,
  i,
}: {
  t: NonNullable<TilesData["leads"]>;
  own: boolean;
  unassigned?: number;
  i: number;
}) {
  const day = weekdayOf(t.day);
  const tr = t.lastWeek > 0 ? trend(t.today, t.lastWeek) : null;
  const max = Math.max(1, ...t.hours, ...(t.usual ?? []));
  const label = own ? "Your leads" : "Leads";
  const foot =
    unassigned && unassigned > 0 ? (
      <>
        <b>{count(unassigned)}</b> with no one yet
      </>
    ) : t.today > 0 ? (
      <>
        Reached <b>{count(t.reached)}</b> of {count(t.today)}
        {t.medianMinutes !== null && <> · half within {minutes(t.medianMinutes)}</>}
      </>
    ) : (
      <>No new leads yet today</>
    );
  return (
    <Tile
      href="/leads"
      icon={I.leads}
      label={label}
      i={i}
      aria={`${label}: ${t.today} new today${tr ? `, ${tr.text} vs last ${day} by this time` : ""}`}
    >
      <Big value={count(t.today)} unit="new today">
        {tr ? (
          <>
            <Chip trend={tr} />
            <span>vs last {day} by now</span>
          </>
        ) : (
          <span>{t.lastWeek === 0 ? `None by now last ${day}` : ""}</span>
        )}
      </Big>
      <div className={s.viz} aria-hidden>
        <div
          className={s.bars}
          title={t.usual ? `Faint: a usual ${day}, from the last ${t.weeks} weeks` : undefined}
        >
          {t.hours.map((n, h) => (
            <span key={h}>
              {t.usual && <i className={s.usual} style={{ height: `${(t.usual[h]! / max) * 100}%` }} />}
              {n > 0 && (
                <i
                  className={s.got}
                  data-now={h === t.hourNow || undefined}
                  style={{ height: `${Math.max(6, (n / max) * 100)}%`, ...v(h) }}
                />
              )}
            </span>
          ))}
        </div>
      </div>
      <div className={s.foot}>{foot}</div>
    </Tile>
  );
}

/** The month: what's been won so far, against the same days of last month, and the goal it counts toward. */
function MonthTile({
  t,
  own,
  currency,
  i,
}: {
  t: NonNullable<TilesData["month"]>;
  own: boolean;
  currency: string;
  i: number;
}) {
  const month = monthOf(t.from);
  const shown = (n: number) => (t.money ? money(n, currency) : count(n));
  const tr = t.previous > 0 ? trend(t.value, t.previous) : null;
  const raw = `${own ? "Your " : ""}${t.money ? "revenue" : "wins"} · ${month}`;
  const label = raw[0]!.toUpperCase() + raw.slice(1);
  const g = t.goal;
  const lastDay = new Date(Date.UTC(Number(t.from.slice(0, 4)), Number(t.from.slice(5, 7)), 0)).getUTCDate();
  return (
    <Tile
      href={t.money ? "/analytics?m=revenue&range=this_month" : "/analytics?range=this_month"}
      icon={t.money ? I.money : I.won}
      label={label}
      i={i}
      lit
      aria={`${label}: ${shown(t.value)}${tr ? `, ${tr.text} ${sameDaysLastMonth(t.to)}` : ""}${g ? `, ${pct(t.value / g.target)} of the goal` : ""}`}
    >
      <Big value={shown(t.value)} unit={t.money ? "won" : t.value === 1 ? "deal won" : "deals won"}>
        {tr ? (
          <>
            <Chip trend={tr} />
            <span>{sameDaysLastMonth(t.to)}</span>
          </>
        ) : null}
      </Big>
      <div className={`${s.viz} ${s.goalArea}`}>
        {g && (
          <>
            {/* The bar is progress; the tick is where an even pace would be today. */}
            <div
              className={s.gbar}
              role="img"
              aria-label={`${pct(Math.min(1, g.value / g.target))} of the goal; an even pace would be at ${pct(g.elapsed)}`}
            >
              <i style={{ width: `${Math.min(100, (g.value / g.target) * 100)}%` }} />
              <b style={{ left: `${g.elapsed * 100}%` }} />
            </div>
            <div className={s.gscale} data-live-count>
              <span>
                {pct(g.value / g.target)} of {shown(g.target)}
                {g.scope === "team" ? " (team goal)" : ""}
              </span>
              <span>
                {g.daysLeft} {g.daysLeft === 1 ? "day" : "days"} left
              </span>
            </div>
          </>
        )}
      </div>
      <div className={s.foot} data-live-count>
        {g && g.pace !== null ? (
          <>
            At this pace: <b>{shown(g.pace * g.target)}</b> by {month.slice(0, 3)} {lastDay}
          </>
        ) : g ? (
          <>Too early in {month} to say where it ends</>
        ) : (
          <>No goal set for {month}</>
        )}
      </div>
    </Tile>
  );
}

/** The pipeline right now: open leads by the business's own stages, in order. */
function PipelineTile({
  t,
  own,
  currency,
  i,
}: {
  t: NonNullable<TilesData["pipeline"]>;
  own: boolean;
  currency: string;
  i: number;
}) {
  const label = own ? "Your pipeline" : t.many ? `Pipeline · ${t.name}` : "Pipeline";
  const total = Math.max(1, t.open);
  const n = t.stages.length;
  // The last two open stages are the closest to a decision; then what was won this month.
  const keys = [
    ...t.stages.slice(-2).map((st, k) => ({
      name: st.name,
      n: st.n,
      color: `rgba(42, 91, 255, ${n <= 1 ? 1 : 0.55 + 0.45 * ((n - 2 + k) / (n - 1))})`,
    })),
    { name: "Won this month", n: t.wonThisMonth, color: "var(--ok)" },
  ];
  return (
    <Tile href="/pipeline" icon={I.pipeline} label={label} i={i} aria={`${label}: ${t.open} open leads`}>
      <Big value={count(t.open)} unit="open leads" />
      <div className={s.viz}>
        {t.open > 0 ? (
          <div className={s.stack}>
            <div className={s.sbar} aria-hidden>
              {t.stages.map((st, k) =>
                st.n > 0 ? (
                  <i
                    key={st.id}
                    title={`${st.name}: ${count(st.n)}`}
                    style={{
                      width: `${(st.n / total) * 100}%`,
                      opacity: n <= 1 ? 1 : 0.3 + 0.7 * (k / (n - 1)),
                      ...v(k),
                    }}
                  />
                ) : null,
              )}
            </div>
            <div className={s.keys} data-live-count>
              {keys.map((k) => (
                <div key={k.name}>
                  <b>
                    <i style={{ background: k.color }} />
                    {count(k.n)}
                  </b>
                  <span>{k.name}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <span className={s.empty}>No open leads right now</span>
        )}
      </div>
      <div className={s.foot} data-live-count>
        {t.forecast !== null ? (
          <>
            <b>{money(t.forecast, currency)}</b> forecast
          </>
        ) : t.many && t.openEverywhere !== null ? (
          <>
            <b>{count(t.openEverywhere)}</b> open across all pipelines
          </>
        ) : (
          <>Open leads right now, by stage</>
        )}
      </div>
    </Tile>
  );
}

/** Calls: the viewer's own, today and this week. */
function CalendarTile({ t, i }: { t: TilesData["calendar"]; i: number }) {
  const week = t.week.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...t.week);
  return (
    <Tile
      href="/calendar"
      icon={I.calendar}
      label="Calendar"
      i={i}
      aria={`Calendar: ${t.today} calls today, ${week} this week`}
    >
      <Big value={count(t.today)} unit={t.today === 1 ? "call today" : "calls today"} />
      <div className={s.viz} aria-hidden>
        <div className={s.week}>
          {t.week.map((c, k) => {
            const day = addDays(t.weekStart, k);
            return (
              <span
                key={day}
                data-today={k === t.todayIndex || undefined}
                data-past={k < t.todayIndex || undefined}
                title={`${weekdayOf(day)}: ${c}`}
              >
                <i style={{ height: `${Math.max(8, (c / max) * 100)}%`, ...v(k) }} />
                {weekdayOf(day)[0]}
              </span>
            );
          })}
        </div>
      </div>
      <div className={s.foot} data-live-count>
        {week > 0 ? (
          <>
            <b>{t.held}</b> held today · {count(week)} this week
          </>
        ) : t.connected ? (
          <>No calls this week</>
        ) : (
          <>Connect a calendar for calls</>
        )}
      </div>
    </Tile>
  );
}

/** The team: whose follow-ups are overdue right now. */
function TeamTile({ t, i }: { t: NonNullable<TilesData["team"]>; i: number }) {
  const max = Math.max(1, ...t.people.map((p) => p.n));
  return (
    <Tile
      href="/analytics?m=team"
      icon={I.team}
      label="Team"
      i={i}
      aria={`Team: ${t.overdue} follow-ups overdue right now`}
    >
      <Big value={count(t.overdue)} unit="overdue right now" />
      <div className={s.viz}>
        {t.people.length ? (
          <div className={s.ppl} data-live-count>
            {t.people.map((p) => (
              <div key={p.id}>
                <span className={s.pav} style={{ background: avatarColor(p.name) }} aria-hidden>
                  {initials(p.name)}
                </span>
                <span className={s.n}>{p.name}</span>
                <span className={s.tb} aria-hidden>
                  <i style={{ width: `${(p.n / max) * 100}%` }} />
                </span>
                <em>{p.n}</em>
              </div>
            ))}
          </div>
        ) : (
          <span className={s.empty}>Nobody&apos;s follow-ups are overdue</span>
        )}
      </div>
      <div className={s.foot} data-live-count>
        {t.onTime !== null ? (
          <>
            <b>{pct(t.onTime)}</b> done on time this month
          </>
        ) : (
          <>The on-time rate shows after 10 are done this month</>
        )}
      </div>
    </Tile>
  );
}

/** On time, day after day: the viewer's own streak (for someone who sees only their own numbers). */
function StreakTile({ t, i }: { t: NonNullable<TilesData["streak"]>; i: number }) {
  const left = t.dueToday - t.doneToday;
  const nothing = !t.last7.length && !t.dueToday;
  return (
    <Tile href="/analytics" icon={I.ontime} label="On time" i={i} aria={`On time: ${t.days} days in a row`}>
      <Big
        value={nothing ? "—" : count(t.days)}
        unit={nothing ? undefined : t.days === 1 ? "day in a row" : "days in a row"}
      />
      <div className={s.viz} aria-hidden>
        <div className={s.week} style={{ height: 44 }}>
          {t.last7.map((d, k) => (
            <span key={k} data-ok={d === "ok" || undefined} data-missed={d === "missed" || undefined}>
              <i style={{ height: "100%", ...v(k) }} />
            </span>
          ))}
          {t.dueToday > 0 && (
            <span data-today>
              <i style={{ height: `${Math.max(12, (t.doneToday / t.dueToday) * 100)}%` }} />
              Today
            </span>
          )}
        </div>
      </div>
      <div className={s.foot} data-live-count>
        {nothing ? (
          <>Starts with your first follow-up</>
        ) : left > 0 ? (
          <>
            Finish today&apos;s <b>{left}</b> to make it {t.days + 1}
          </>
        ) : t.days > 1 && t.days >= t.best ? (
          <>Your longest run in 60 days</>
        ) : (
          <>Every follow-up due today is done</>
        )}
      </div>
    </Tile>
  );
}

/** Replies: are messages getting answers? The Overview's reply rate, last 7 days. */
function RepliesTile({ t, own, i }: { t: NonNullable<TilesData["replies"]>; own: boolean; i: number }) {
  const tr = t.rate !== null && t.previous !== null ? trend(t.rate, t.previous, { kind: "pts" }) : null;
  const line = sparkLine(t.series);
  let path: { area: string; line: string } | null = null;
  if (line && line.length > 1) {
    const lo = Math.min(...line);
    const hi = Math.max(...line);
    const span = hi - lo || 1;
    const pts = toPts(
      line.map((x) => x - lo + span * 0.15),
      200,
      56,
      span * 1.3,
      2,
    );
    path = { area: areaUnder(pts, 56), line: smooth(pts) };
  }
  const label = own ? "Your replies" : "Replies";
  return (
    <Tile
      href="/analytics?m=quality"
      icon={I.replies}
      label={label}
      i={i}
      aria={`${label}: ${t.rate === null ? "no rate yet" : pct(t.rate)} of contacted leads replied in the last 7 days`}
    >
      <Big value={t.rate === null ? "—" : pct(t.rate)} unit="replied · last 7 days">
        {tr ? (
          <>
            <Chip trend={tr} />
            <span>vs the 7 days before</span>
          </>
        ) : null}
      </Big>
      <div className={s.viz} aria-hidden>
        {path && (
          <svg className={s.spark} viewBox="0 0 200 56" preserveAspectRatio="none" data-live-count>
            <path d={path.area} />
            <path d={path.line} />
          </svg>
        )}
      </div>
      <div className={s.foot} data-live-count>
        {t.best ? (
          <>
            Best template: <b>{t.best.name}</b> · {pct(t.best.rate)}
          </>
        ) : t.rate === null ? (
          <>Shows once leads are contacted</>
        ) : (
          <>No template sent 10+ times yet</>
        )}
      </div>
    </Tile>
  );
}

/** The six tiles' places while they load: the grid keeps its shape. */
export function TileSkeletons() {
  return (
    <>
      {Array.from({ length: 6 }, (_, k) => (
        <div key={k} className={s.tl} aria-hidden style={v(k + 2)}>
          <span className={s.sk} style={{ width: 90, height: 14 }} />
          <span className={s.sk} style={{ width: 120, height: 32, marginTop: 14 }} />
          <span className={s.sk} style={{ height: 52, marginTop: "auto" }} />
        </div>
      ))}
    </>
  );
}
