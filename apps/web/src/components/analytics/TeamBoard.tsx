"use client";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { trend as trendOf, type Trend } from "@lume/core/shared";
import { Avatar } from "@/components/ui/Avatar";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import {
  analyticsClient,
  type Insights,
  type RankMetric,
  type Team,
  type TeamRow,
} from "@/lib/analytics/client";
import { count, minutes, money, pct } from "@/lib/analytics/words";
import type { Catalog } from "@/lib/leads/types";
import { Card, Chip, Skeleton } from "./parts";
import a from "./analytics.module.css";
import s from "./team.module.css";

type Metric = {
  id: RankMetric;
  label: string;
  /** "Most leads won", the leaderboard's sub-heading. */
  words: string;
  good: "up" | "down";
  value: (r: TeamRow) => number | null;
};
const METRICS: Metric[] = [
  { id: "won", label: "Won", words: "Most leads won", good: "up", value: (r) => r.won },
  {
    id: "revenue",
    label: "Revenue",
    words: "Most revenue won",
    good: "up",
    value: (r) => r.revenueWon ?? null,
  },
  {
    id: "speed",
    label: "Speed",
    words: "Fastest median first contact (lower is better)",
    good: "down",
    value: (r) => r.speedToLead,
  },
  {
    id: "ontime",
    label: "On time",
    words: "Most follow-ups done on time",
    good: "up",
    value: (r) => r.ontime,
  },
  { id: "replies", label: "Replies", words: "Highest reply rate", good: "up", value: (r) => r.replyRate },
];
/** Rows the leaderboard shows before "Show all". */
const TOP = 6;
const ROW = 54;
/** The follow-up insights that belong beside the discipline ring. */
const DISCIPLINE_INSIGHTS = ["weekday_late", "followups_slip", "rep_support"];

/**
 * Team (canvas Team board): the leaderboard (rank by won, revenue, speed, on time or replies; each row slides to its
 * new place), follow-up discipline (the team's on-time ring, each person's bar and what's overdue now, and what LUME
 * noticed about follow-ups), and every person's numbers in a table sorted by any heading, each number opening its leads.
 */
export function TeamBoard({
  team,
  insights,
  catalog,
  compare,
  rangeWords,
  onDrill,
}: {
  team: Team | null;
  insights: Insights | null;
  catalog: Catalog;
  compare: boolean;
  /** "Last 30 days". */
  rangeWords: string;
  onDrill(token: string, title: string): void;
}) {
  const [teams, setTeams] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    void analyticsClient.teams().then((r) => {
      if (!r.ok) return;
      const m = new Map<string, string>();
      for (const t of r.data.teams) for (const id of t.memberIds) if (!m.has(id)) m.set(id, t.name);
      setTeams(m);
    });
  }, []);
  if (!team)
    return (
      <div className={s.g2}>
        <Skeleton h={360} />
        <Skeleton h={360} i={1} />
      </div>
    );
  const color = (id: string) => catalog.people.find((p) => p.id === id)?.avatar?.color;
  const av = (r: { id: string; name: string }, size: number) => (
    <Avatar name={r.name} size={size} {...(color(r.id) ? { color: color(r.id)! } : {})} />
  );
  if (!team.people.length)
    return (
      <Card title={team.leaderboard ? "Each person" : "Your numbers"}>
        <p className={a.empty}>No activity in this range yet.</p>
      </Card>
    );
  const insight =
    insights?.ready === true ? insights.insights.find((i) => DISCIPLINE_INSIGHTS.includes(i.id)) : undefined;
  return (
    <>
      <div className={s.g2} data-one={!team.leaderboard || undefined}>
        {team.leaderboard && (
          <Leaderboard
            team={team}
            teams={teams}
            currency={catalog.currency}
            compare={compare}
            rangeWords={rangeWords}
            av={av}
            onDrill={onDrill}
          />
        )}
        <Discipline team={team} rangeWords={rangeWords} insight={insight} av={av} />
      </div>
      <People team={team} currency={catalog.currency} av={av} onDrill={onDrill} />
    </>
  );
}

function Leaderboard({
  team,
  teams,
  currency,
  compare,
  rangeWords,
  av,
  onDrill,
}: {
  team: Team;
  teams: Map<string, string>;
  currency: string;
  compare: boolean;
  rangeWords: string;
  av: (r: TeamRow, size: number) => ReactNode;
  onDrill(token: string, title: string): void;
}) {
  const money_ = team.people.some((p) => p.revenueWon !== undefined);
  const metrics = METRICS.filter((m) => m.id !== "revenue" || money_);
  const [by, setBy] = useState<RankMetric>("won");
  const [all, setAll] = useState(false);
  const M = metrics.find((m) => m.id === by) ?? metrics[0]!;
  const ranked = useMemo(() => {
    const scored = team.people.filter((r) => r.active && M.value(r) !== null);
    return scored.sort((x, y) => {
      const d = M.good === "up" ? M.value(y)! - M.value(x)! : M.value(x)! - M.value(y)!;
      return d || x.name.localeCompare(y.name);
    });
  }, [team.people, M]);
  const shown = all ? ranked : ranked.slice(0, TOP);
  const values = ranked.map((r) => M.value(r)!);
  const best = M.good === "up" ? Math.max(...values, 0) : Math.min(...values.filter((v) => v > 0));
  const show = (v: number) =>
    by === "won" ? count(v) : by === "revenue" ? money(v, currency) : by === "speed" ? minutes(v) : pct(v);
  const change = (r: TeamRow): Trend | null => {
    if (!compare) return null;
    const now = M.value(r);
    const before = r.previous[by];
    if (now === null) return null;
    if (before === null || before === undefined) return { dir: "up", tone: "good", text: "New" };
    if (by === "speed") return trendOf(now, before, { kind: "abs", good: "down", format: (n) => minutes(n) });
    return trendOf(now, before, { kind: by === "ontime" || by === "replies" ? "pts" : "pct", good: "up" });
  };
  const ids = new Set(shown.map((r) => r.id));
  return (
    <Card
      title="Leaderboard"
      sub={`${M.words}, ${rangeWords.toLowerCase()}`}
      right={
        <SegmentedControl
          label="Rank by"
          value={M.id}
          options={metrics.map((m) => ({ value: m.id, label: m.label }))}
          onChange={(v) => setBy(v as RankMetric)}
        />
      }
    >
      {ranked.length === 0 ? (
        <p className={a.empty}>Nobody has a number for this yet in the range.</p>
      ) : (
        <>
          <ol className={s.lb} style={{ height: shown.length * ROW }} aria-label={`Leaderboard: ${M.words}`}>
            {/* Every person keeps their row; only its place changes, so a new ranking slides into place. */}
            {team.people
              .filter((r) => ids.has(r.id))
              .map((r) => {
                const rank = shown.indexOf(r);
                const v = M.value(r)!;
                const frac = M.good === "up" ? (best ? v / best : 0) : v ? best / v : 0;
                const token = by === "won" || by === "revenue" ? r.drill.won : r.drill.cohort;
                return (
                  <li
                    key={r.id}
                    className={s.lr}
                    data-first={rank === 0 || undefined}
                    style={{ transform: `translateY(${rank * ROW}px)` } as CSSProperties}
                  >
                    <button
                      type="button"
                      disabled={!token}
                      aria-label={`${rank + 1}. ${r.name}: ${show(v)}. See the leads.`}
                      onClick={() => token && onDrill(token, `${r.name}: ${M.label.toLowerCase()}`)}
                    >
                      <span className={s.rk}>{rank + 1}</span>
                      {av(r, 34)}
                      <span className={s.who}>
                        <b>{r.name}</b>
                        {teams.get(r.id) && <span>{teams.get(r.id)}</span>}
                      </span>
                      <span className={s.bar3}>
                        <i style={{ width: `${Math.max(2, Math.min(1, frac) * 100)}%` }} />
                      </span>
                      <span className={s.val}>{show(v)}</span>
                      <span className={s.ch}>
                        <Chip trend={change(r)} />
                      </span>
                    </button>
                  </li>
                );
              })}
          </ol>
          {ranked.length > TOP && (
            <button type="button" className={s.more} onClick={() => setAll((x) => !x)}>
              {all ? "Show the top six" : `Show all ${ranked.length}`}
            </button>
          )}
        </>
      )}
    </Card>
  );
}

const barTone = (v: number) => (v >= 0.9 ? "good" : v >= 0.8 ? "warn" : "bad");

function Discipline({
  team,
  rangeWords,
  insight,
  av,
}: {
  team: Team;
  rangeWords: string;
  insight: { title: string; body: string } | undefined;
  av: (r: { id: string; name: string }, size: number) => ReactNode;
}) {
  const d = team.discipline;
  const [all, setAll] = useState(false);
  const name = (id: string) => team.people.find((p) => p.id === id)?.name ?? "Someone";
  const people = d.people
    .filter((p) => p.ontime !== null || p.overdueNow > 0)
    .sort((x, y) => (y.ontime ?? -1) - (x.ontime ?? -1) || y.overdueNow - x.overdueNow);
  const shown = all ? people : people.slice(0, TOP);
  return (
    <Card
      title="Follow-up discipline"
      sub={`Follow-ups done by their due time, ${rangeWords.toLowerCase().replace(/^last/, "in the last")}`}
      right={d.trend ? <Chip trend={d.trend} /> : undefined}
    >
      {d.ontime === null && d.overdueNow === 0 ? (
        <p className={a.empty}>No follow-ups were due in this range.</p>
      ) : (
        <div className={s.disc}>
          <div className={s.dring}>
            <svg viewBox="0 0 150 150" aria-hidden>
              <circle className={s.dbg} cx="75" cy="75" r="65" />
              <circle
                className={s.dfg}
                cx="75"
                cy="75"
                r="65"
                data-tone={d.ontime === null ? undefined : barTone(d.ontime)}
                style={{ "--to": 408 - 408 * (d.ontime ?? 0) } as CSSProperties}
              />
            </svg>
            <div className={s.ctr}>
              <div>
                <b>{d.ontime === null ? "—" : pct(d.ontime)}</b>
                <span>on time</span>
              </div>
            </div>
          </div>
          <div className={s.drs}>
            <div className={s.dh} aria-hidden>
              <span />
              <span>On time</span>
              <span />
              <span>Overdue now</span>
            </div>
            {shown.map((p, i) => (
              <div key={p.id} className={s.dr} style={{ "--i": i } as CSSProperties}>
                {av({ id: p.id, name: name(p.id) }, 22)}
                <span className={s.tr4} title={name(p.id)}>
                  {p.ontime !== null && (
                    <i data-tone={barTone(p.ontime)} style={{ width: `${p.ontime * 100}%` }} />
                  )}
                </span>
                <span className={s.pc}>{p.ontime === null ? "—" : pct(p.ontime)}</span>
                <span className={s.od} data-red={p.overdueNow > 5 || undefined}>
                  {p.overdueNow ? `${count(p.overdueNow)} overdue` : "none"}
                </span>
                <span className={s.srOnly}>
                  {name(p.id)}: {p.ontime === null ? "no follow-ups due" : `${pct(p.ontime)} on time`},{" "}
                  {p.overdueNow ? `${p.overdueNow} overdue now` : "none overdue"}
                </span>
              </div>
            ))}
            {people.length > TOP && (
              <button type="button" className={s.more} onClick={() => setAll((x) => !x)}>
                {all ? "Show fewer" : `Show all ${people.length}`}
              </button>
            )}
          </div>
        </div>
      )}
      {insight && (
        <div className={s.ins}>
          <span className={s.spk} aria-hidden>
            <img src="/lume-mark.png" alt="" />
          </span>
          <div>
            <b>{insight.title}</b>
            <p>{insight.body}</p>
          </div>
        </div>
      )}
    </Card>
  );
}

type Col = { key: string; label: string; get: (r: TeamRow) => number | null };

function People({
  team,
  currency,
  av,
  onDrill,
}: {
  team: Team;
  currency: string;
  av: (r: TeamRow, size: number) => ReactNode;
  onDrill(token: string, title: string): void;
}) {
  const money_ = team.people.some((p) => p.revenueWon !== undefined);
  const goals = team.people.some((p) => p.goal);
  const cols: Col[] = [
    { key: "assigned", label: "Assigned", get: (r) => r.assigned },
    { key: "contacted", label: "Contacted", get: (r) => r.contacted },
    { key: "speed", label: "Speed to lead", get: (r) => r.speedToLead },
    { key: "within", label: "Within 1 h", get: (r) => r.within1h },
    { key: "reply", label: "Reply rate", get: (r) => r.replyRate },
    { key: "held", label: "Calls held", get: (r) => r.held },
    { key: "won", label: "Won", get: (r) => r.won },
    ...(money_ ? [{ key: "revenue", label: "Revenue", get: (r: TeamRow) => r.revenueWon ?? 0 }] : []),
    { key: "ontime", label: "On time", get: (r) => r.ontime },
  ];
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "won", dir: -1 });
  const col = cols.find((c) => c.key === sort.key) ?? cols[6]!;
  const rows = [...team.people].sort((x, y) => {
    const vx = col.get(x);
    const vy = col.get(y);
    if (vx === null || vy === null) return vx === vy ? x.name.localeCompare(y.name) : vx === null ? 1 : -1;
    return (vx - vy) * sort.dir || x.name.localeCompare(y.name);
  });
  // Speed reads against the team's own median: well under it is good, far over it is slow.
  const speeds = team.people
    .flatMap((r) => (r.speedToLead === null ? [] : [r.speedToLead]))
    .sort((p, q) => p - q);
  const median = speeds.length ? speeds[Math.floor(speeds.length / 2)]! : null;
  const speedTone = (v: number | null) =>
    v === null || median === null || speeds.length < 3
      ? undefined
      : v <= median * 0.75
        ? "good"
        : v >= median * 1.5
          ? "bad"
          : undefined;
  const show = (c: Col, r: TeamRow) => {
    const v = c.get(r);
    if (v === null) return "—";
    if (c.key === "speed") return minutes(v);
    if (["contacted", "within", "reply", "ontime"].includes(c.key)) return pct(v);
    if (c.key === "revenue") return money(v, currency);
    return count(v);
  };
  const drillOf = (c: Col, r: TeamRow) =>
    c.key === "assigned" ? r.drill.cohort : c.key === "won" || c.key === "revenue" ? r.drill.won : undefined;
  return (
    <section
      className={`${a.card} ${s.people}`}
      style={{ "--i": 2 } as CSSProperties}
      aria-label="Each person"
    >
      <div className={a.cardHead}>
        <div>
          <h3>{team.leaderboard ? "Each person" : "Your numbers"}</h3>
          <div className={a.sub}>
            Credited to whoever owned the lead at the time. Click a heading to sort; a number opens the leads
            behind it
          </div>
        </div>
      </div>
      <div className={s.scroll}>
        <table className={s.tt}>
          <thead>
            <tr>
              <th scope="col">Person</th>
              {cols.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={sort.key === c.key ? (sort.dir < 0 ? "descending" : "ascending") : undefined}
                >
                  <button
                    type="button"
                    data-on={sort.key === c.key || undefined}
                    onClick={() =>
                      setSort((x) => ({ key: c.key, dir: x.key === c.key ? (-x.dir as 1 | -1) : -1 }))
                    }
                  >
                    {c.label}
                    <svg viewBox="0 0 12 12" aria-hidden>
                      {sort.key === c.key && (
                        <path d={sort.dir < 0 ? "M3 4.5 6 7.5l3-3" : "M3 7.5 6 4.5l3 3"} />
                      )}
                    </svg>
                  </button>
                </th>
              ))}
              {goals && <th scope="col">Goal</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className={s.rep}>
                  {av(r, 26)}
                  <b>{r.name}</b>
                  {!r.active && <span className={s.left}>left</span>}
                </td>
                {cols.map((c) => {
                  const token = drillOf(c, r);
                  const text = show(c, r);
                  return (
                    <td
                      key={c.key}
                      data-tone={c.key === "speed" ? speedTone(r.speedToLead) : undefined}
                      data-red={(c.key === "overdue" && r.overdueNow > 0) || undefined}
                    >
                      {token && text !== "0" ? (
                        <button
                          type="button"
                          className={s.num}
                          aria-label={`${r.name}, ${c.label.toLowerCase()}: ${text}. See the leads.`}
                          onClick={() => onDrill(token, `${r.name}: ${c.label.toLowerCase()}`)}
                        >
                          {text}
                        </button>
                      ) : (
                        text
                      )}
                    </td>
                  );
                })}
                {goals && (
                  <td>
                    {r.goal ? (
                      <span className={s.goalm} data-hit={r.goal.value >= r.goal.target || undefined}>
                        <span className={s.tr5}>
                          <i
                            style={{ width: `${Math.min(1, r.goal.value / (r.goal.target || 1)) * 100}%` }}
                          />
                        </span>
                        <span>
                          {r.goal.metric === "revenue"
                            ? `${money(r.goal.value, currency)} of ${money(r.goal.target, currency)}`
                            : `${count(r.goal.value)} of ${count(r.goal.target)}`}
                        </span>
                      </span>
                    ) : (
                      <span className={s.none}>—</span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
