"use client";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { analyticsClient, type Goals } from "@/lib/analytics/client";
import {
  parseTarget,
  periodLast,
  periodOf,
  periodWords,
  shiftPeriod,
  suggestions,
  targetText,
  type GoalMetric,
  type GoalPeriod,
} from "@/lib/analytics/goal-periods";
import { count, money, pct } from "@/lib/analytics/words";
import type { Person } from "@/lib/leads/types";
import s from "./goals.module.css";

type Scope = "business" | "team" | "user";
type Goal = Goals["goals"][number];
const ROWS: { metric: GoalMetric; label: string; blurb: string; tile: string }[] = [
  { metric: "revenue", label: "Revenue won", blurb: "Value of leads won in the period", tile: "revenue_won" },
  { metric: "won", label: "Won", blurb: "Leads moved to Won in the period", tile: "won" },
  {
    metric: "calls_held",
    label: "Calls held",
    blurb: "Meetings with leads that took place",
    tile: "calls_held",
  },
  { metric: "new_leads", label: "New leads", blurb: "Leads that arrived in the period", tile: "new_leads" },
  {
    metric: "ontime",
    label: "Follow-ups on time",
    blurb: "Done by their due time, of those due",
    tile: "ontime",
  },
];
const TEAM_METRICS: GoalMetric[] = ["won", "revenue", "calls_held"];
const PERSON_METRICS: GoalMetric[] = ["won", "revenue"];
const WORDS: Record<GoalMetric, string> = {
  revenue: "Revenue won",
  won: "Won",
  calls_held: "Calls held",
  new_leads: "New leads",
  ontime: "On time",
};
const keyOf = (scope: Scope, scopeId: string | null, metric: GoalMetric) =>
  `${scope}|${scopeId ?? ""}|${metric}`;

/**
 * Settings → Goals (8D-3, the approved Goals board): what the business, each team and each person aim for, a month
 * or a quarter at a time. Each box saves as you leave it (empty removes the goal); the business's last period sits
 * beside each with "Same" and "+10%"; on the right, Analytics and the Monday email as they'll read, as you type.
 */
export function GoalsEditor({
  currency,
  seesMoney,
  people,
  today,
}: {
  currency: string;
  seesMoney: boolean;
  people: Person[];
  /** Today in the business's timezone ("2026-10-05"). */
  today: string;
}) {
  const [period, setPeriod] = useState<GoalPeriod>("month");
  const [start, setStart] = useState(() => periodOf(today, "month"));
  const [goals, setGoals] = useState<Goals | null>(null);
  const [before, setBefore] = useState<Partial<Record<GoalMetric, number | null>>>({});
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  const [text, setText] = useState<Record<string, string>>({});
  const [state, setState] = useState<Record<string, "saving" | "saved" | "error">>({});
  const [loadError, setLoadError] = useState(false);
  const words = periodWords(start, period);
  const prev = shiftPeriod(start, period, -1);
  const prevWords = periodWords(prev, period);
  const metrics = (xs: GoalMetric[]) => xs.filter((m) => m !== "revenue" || seesMoney);

  const load = useCallback(async () => {
    const r = await analyticsClient.goals(start, period);
    if (!r.ok) return setLoadError(true);
    setLoadError(false);
    setGoals(r.data);
    const t: Record<string, string> = {};
    for (const g of r.data.goals)
      t[keyOf(g.scope, g.scopeId, g.metric)] = targetText(g.target, g.metric, currency);
    setText(t);
  }, [start, period, currency]);

  useEffect(() => {
    setGoals(null);
    void load();
    // The period before, as Analytics counted it: the hint beside each business goal.
    void analyticsClient
      .overview({ range: "custom", from: prev, to: periodLast(prev, period), compare: false })
      .then((r) => {
        if (!r.ok) return setBefore({});
        const v: Partial<Record<GoalMetric, number | null>> = {};
        for (const row of ROWS) v[row.metric] = r.data.tiles.find((x) => x.id === row.tile)?.value ?? null;
        setBefore(v);
      });
  }, [load, prev, period]);
  useEffect(() => {
    void analyticsClient.teams().then((r) => r.ok && setTeams(r.data.teams));
  }, []);

  const find = (scope: Scope, scopeId: string | null, metric: GoalMetric): Goal | undefined =>
    goals?.goals.find((g) => g.scope === scope && (g.scopeId ?? null) === scopeId && g.metric === metric);

  const save = async (scope: Scope, scopeId: string | null, metric: GoalMetric, raw?: string) => {
    const k = keyOf(scope, scopeId, metric);
    const typed = raw ?? text[k] ?? "";
    const target = parseTarget(typed, metric);
    const had = find(scope, scopeId, metric);
    if (typed.trim() && target === null) return setState((x) => ({ ...x, [k]: "error" }));
    if ((had?.target ?? null) === target) return;
    setState((x) => ({ ...x, [k]: "saving" }));
    const r =
      target === null
        ? await analyticsClient.removeGoal(had!.id)
        : await analyticsClient.setGoal({ scope, scopeId, metric, period, periodStart: start, target });
    setState((x) => ({ ...x, [k]: r.ok ? "saved" : "error" }));
    if (r.ok) await load();
  };
  const fill = (metric: GoalMetric, v: number) => {
    const k = keyOf("business", null, metric);
    const t = targetText(v, metric, currency);
    setText((x) => ({ ...x, [k]: t }));
    void save("business", null, metric, t);
  };

  const box = (scope: Scope, scopeId: string | null, metric: GoalMetric, label: string) => {
    const k = keyOf(scope, scopeId, metric);
    return (
      <span className={s.box} data-state={state[k]} data-money={metric === "revenue" || undefined}>
        {metric === "revenue" && <span className={s.cur}>{currency}</span>}
        <input
          inputMode="decimal"
          autoComplete="off"
          aria-label={label}
          aria-invalid={state[k] === "error" || undefined}
          placeholder="—"
          value={text[k] ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            setText((x) => ({ ...x, [k]: v }));
            setState((x) => {
              const n = { ...x };
              delete n[k];
              return n;
            });
          }}
          onBlur={() => void save(scope, scopeId, metric)}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        {metric === "ontime" && <span className={s.pctSign}>%</span>}
      </span>
    );
  };

  // As you type: the business's goals with what's typed now, read as Analytics and the email will.
  const live = (metric: GoalMetric) => {
    const typed = parseTarget(text[keyOf("business", null, metric)] ?? "", metric);
    const g = find("business", null, metric);
    return typed === null ? null : { target: typed, value: g?.value ?? 0, elapsed: g?.elapsed ?? null };
  };
  const show = (metric: GoalMetric, v: number) =>
    metric === "revenue" ? money(v, currency) : metric === "ontime" ? pct(v) : count(v);
  const lead = (["revenue", "won"] as GoalMetric[])
    .map((m) => ({ m, g: live(m) }))
    .find((x) => x.g && (x.m !== "revenue" || seesMoney));
  const others = metrics(["won", "calls_held", "new_leads"])
    .filter((m) => m !== lead?.m)
    .flatMap((m) => {
      const g = live(m);
      return g ? [{ m, g }] : [];
    });
  const pace =
    lead?.g && lead.g.elapsed !== null && lead.g.elapsed >= 0.2
      ? lead.g.value / lead.g.elapsed / lead.g.target
      : null;
  const someone = useMemo(() => people.find((p) => p.active), [people]);
  const savedAny = Object.values(state).includes("saved");

  return (
    <div className={s.layout}>
      <div className={s.main}>
        <div className={s.bar}>
          <SegmentedControl
            label="Goals for a"
            value={period}
            options={[
              { value: "month", label: "Month" },
              { value: "quarter", label: "Quarter" },
            ]}
            onChange={(v) => {
              setPeriod(v as GoalPeriod);
              setStart(periodOf(today, v as GoalPeriod));
            }}
          />
          <span className={s.nav}>
            <button type="button" aria-label="The period before" onClick={() => setStart(prev)}>
              <svg viewBox="0 0 16 16" aria-hidden>
                <path d="m10 3.5-4.5 4.5 4.5 4.5" />
              </svg>
            </button>
            <b aria-live="polite">{words.label}</b>
            <button
              type="button"
              aria-label="The period after"
              onClick={() => setStart(shiftPeriod(start, period, 1))}
            >
              <svg viewBox="0 0 16 16" aria-hidden>
                <path d="m6 3.5 4.5 4.5L6 12.5" />
              </svg>
            </button>
          </span>
        </div>

        {loadError ? (
          <p role="alert" className={s.err}>
            LUME couldn&rsquo;t load the goals just now. Reload the page to try again.
          </p>
        ) : (
          <>
            <section className={s.card} aria-label="The business">
              <div className={s.head}>
                <h2>The business</h2>
                {savedAny && (
                  <span className={s.saved} role="status">
                    <svg viewBox="0 0 16 16" aria-hidden>
                      <path d="m3.5 8.5 3 3 6-7" />
                    </svg>
                    Saved
                  </span>
                )}
              </div>
              {ROWS.filter((r) => r.metric !== "revenue" || seesMoney).map((r) => {
                const b = before[r.metric] ?? null;
                const sg = suggestions(b, r.metric);
                return (
                  <div key={r.metric} className={s.row}>
                    <div className={s.what}>
                      <b>{r.label}</b>
                      <span>{r.blurb}</span>
                    </div>
                    {box("business", null, r.metric, `${r.label}, the business, ${words.label}`)}
                    <div className={s.hint}>
                      {b !== null && (
                        <span>
                          {prevWords.short}: <b>{show(r.metric, b)}</b>
                        </span>
                      )}
                      {sg && (
                        <>
                          <button type="button" onClick={() => fill(r.metric, sg.same)}>
                            Same
                          </button>
                          <button type="button" onClick={() => fill(r.metric, sg.up)}>
                            +10%
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>

            {teams.length > 0 && (
              <section className={s.card} aria-label="Teams">
                <div className={s.head}>
                  <h2>Teams</h2>
                  <span className={s.opt}>
                    Optional · each team&rsquo;s leads, credited as Analytics credits them
                  </span>
                </div>
                <table className={s.grid}>
                  <thead>
                    <tr>
                      <th scope="col">Team</th>
                      {metrics(TEAM_METRICS).map((m) => (
                        <th key={m} scope="col">
                          {WORDS[m]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {teams.map((t) => (
                      <tr key={t.id}>
                        <th scope="row">{t.name}</th>
                        {metrics(TEAM_METRICS).map((m) => (
                          <td key={m}>{box("team", t.id, m, `${WORDS[m]}, ${t.name}, ${words.label}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            <section className={s.card} aria-label="People">
              <div className={s.head}>
                <h2>People</h2>
                <span className={s.opt}>Optional · each person sees their own on My numbers</span>
              </div>
              <table className={s.grid}>
                <thead>
                  <tr>
                    <th scope="col">Person</th>
                    {metrics(PERSON_METRICS).map((m) => (
                      <th key={m} scope="col">
                        {WORDS[m]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {people
                    .filter((p) => p.active)
                    .map((p) => (
                      <tr key={p.id}>
                        <th scope="row">
                          <span className={s.who}>
                            <Avatar
                              name={p.name}
                              size={24}
                              {...(p.avatar?.color ? { color: p.avatar.color } : {})}
                            />
                            {p.name}
                          </span>
                        </th>
                        {metrics(PERSON_METRICS).map((m) => (
                          <td key={m}>{box("user", p.id, m, `${WORDS[m]}, ${p.name}, ${words.label}`)}</td>
                        ))}
                      </tr>
                    ))}
                </tbody>
              </table>
            </section>
          </>
        )}
      </div>

      <aside className={s.side} aria-label="How these goals will read">
        <section className={s.pane}>
          <h3>On Analytics · as you type</h3>
          <div className={s.preview}>
            <b>{words.label.split(" ")[0]} goals</b>
            <span className={s.pSub}>The business, this {period}</span>
            {!lead && !others.length ? (
              <p className={s.pEmpty}>Type a goal and it shows here, the way Analytics will show it.</p>
            ) : (
              <div className={s.pBody}>
                {lead?.g && (
                  <div className={s.pRing}>
                    <svg viewBox="0 0 92 92" aria-hidden>
                      <circle cx="46" cy="46" r="38" className={s.rbg} />
                      <circle
                        cx="46"
                        cy="46"
                        r="38"
                        className={s.rfg}
                        style={
                          { "--to": 239 - 239 * Math.min(1, lead.g.value / lead.g.target) } as CSSProperties
                        }
                      />
                    </svg>
                    <span>
                      <b>{pct(Math.min(9.99, lead.g.value / lead.g.target))}</b>
                      of {WORDS[lead.m].toLowerCase()}
                    </span>
                  </div>
                )}
                <div className={s.pBars}>
                  {others.map(({ m, g }) => (
                    <div key={m}>
                      <span>
                        <b>{WORDS[m]}</b>
                        {show(m, g.value)} of {show(m, g.target)}
                      </span>
                      <i>
                        <i style={{ width: `${Math.min(1, g.value / g.target) * 100}%` }} />
                      </i>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {pace !== null && lead && (
              <div className={s.pPace}>
                <span>At this pace, {words.label.split(" ")[0]} ends at</span>
                <b>
                  {pct(pace)} of the {WORDS[lead.m].toLowerCase()} goal (an estimate)
                </b>
              </div>
            )}
          </div>
        </section>
        <section className={s.pane}>
          <h3>In the Monday email</h3>
          <dl className={s.email}>
            {[lead, ...others.map((x) => ({ m: x.m, g: x.g }))].flatMap((x) =>
              x?.g
                ? [
                    <div key={x.m}>
                      <dt>{WORDS[x.m]}</dt>
                      <dd>
                        {show(x.m, x.g.value)} of {show(x.m, x.g.target)}
                        {x.m === "revenue" ? ` (${pct(x.g.value / x.g.target)})` : ""}
                      </dd>
                    </div>,
                  ]
                : [],
            )}
            {pace !== null && (
              <div>
                <dt>At this pace</dt>
                <dd>{pct(pace)} of goal</dd>
              </div>
            )}
          </dl>
          {!lead && !others.length && <p className={s.pEmpty}>No goals yet, so the email leaves them out.</p>}
        </section>
        {someone && (
          <section className={s.pane}>
            {/* Names the person, never a guessed "his" or "her" (owner, 2026-10-05). */}
            <h3>What {someone.name.split(" ")[0]} sees</h3>
            <div className={s.sees}>
              <Avatar
                name={someone.name}
                size={30}
                {...(someone.avatar?.color ? { color: someone.avatar.color } : {})}
              />
              <span>
                <b>{someone.name.split(" ")[0]}&rsquo;s own goals</b>
                and the business&rsquo;s, on My numbers
              </span>
            </div>
          </section>
        )}
      </aside>
    </div>
  );
}
