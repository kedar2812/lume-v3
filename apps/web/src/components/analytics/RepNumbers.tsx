"use client";
import Link from "next/link";
import type { CSSProperties } from "react";
import { METRICS } from "@lume/core/shared";
import { Avatar } from "@/components/ui/Avatar";
import type { Me } from "@/lib/analytics/client";
import { count, money, pct, repLine, shown } from "@/lib/analytics/words";
import { Card, Chip, Skeleton } from "./parts";
import a from "./analytics.module.css";
import s from "./rep.module.css";

const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** The tiles the canvas shows a rep, in its order, with its words. */
const TILES: { id: Me["tiles"][number]["id"]; words: string }[] = [
  { id: "new_leads", words: "Your new leads" },
  { id: "contacted", words: "Contacted" },
  { id: "reply_rate", words: "Reply rate" },
  { id: "speed_to_lead", words: "First contact (median)" },
  { id: "won", words: "Won" },
  { id: "revenue_won", words: "Your revenue won" },
];
const GOAL_WORDS = {
  won: "Won",
  revenue: "Revenue",
  calls_held: "Calls held",
  new_leads: "New leads",
  ontime: "On time",
};

/** "Due 11:30 am" today, "Tomorrow", or "October 6, Tuesday" (the owner's date style). */
function dueWords(iso: string, tz: string, now: Date): { text: string; late: boolean } {
  const at = new Date(iso);
  const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
  const late = at.getTime() < now.getTime();
  if (day(at) === day(now))
    return {
      text: `Due ${at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).toLowerCase()}`,
      late,
    };
  if (late)
    return {
      text: `Was due ${at.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: tz })}`,
      late,
    };
  if (day(at) === day(new Date(now.getTime() + 86_400_000))) return { text: "Tomorrow", late };
  const md = at.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: tz });
  const wd = at.toLocaleDateString("en-US", { weekday: "long", timeZone: tz });
  return { text: `${md}, ${wd}`, late };
}

/**
 * A rep's own numbers (canvas Rep, "My numbers"): the month so far with their goals as rings, their numbers against
 * the period before, the follow-ups due now and next, their funnel beside the business's win rate, and the weekdays
 * their leads reply.
 */
export function RepNumbers({
  me,
  currency,
  timezone,
  compare,
  rangeWords,
  now = new Date(),
}: {
  me: Me | null;
  currency: string;
  timezone: string;
  compare: boolean;
  rangeWords: string;
  now?: Date;
}) {
  if (!me)
    return (
      <div aria-busy="true">
        <Skeleton h={164} />
        <div style={{ height: 14 }} />
        <Skeleton h={106} i={1} />
      </div>
    );
  const month = new Date().toLocaleDateString("en-US", { month: "long", timeZone: timezone });
  const tiles = TILES.flatMap((x) => {
    const t = me.tiles.find((y) => y.id === x.id);
    return t ? [{ ...t, words: x.words }] : [];
  });
  const days = me.replyDays;
  const real = days.filter((d) => !d.tooFew && d.rate !== null);
  const bestDay = real.length >= 2 ? real.reduce((x, y) => (y.rate! > x.rate! ? y : x)) : null;
  const worstDay = real.length >= 2 ? real.reduce((x, y) => (y.rate! < x.rate! ? y : x)) : null;
  const most = Math.max(0.01, ...real.map((d) => d.rate!));
  return (
    <>
      <section className={s.hero} aria-label={`Your ${month}, so far`}>
        <div className={s.heroText}>
          <h2>Your {month}, so far</h2>
          <p>{repLine(me.tiles, me.followUps.dueNow)}</p>
        </div>
        {me.goals.length > 0 && (
          <div className={s.rings}>
            {me.goals.slice(0, 3).map((g) => {
              const frac = Math.min(1, g.target ? g.value / g.target : 0);
              const val = (v: number) =>
                g.metric === "revenue" ? money(v, currency) : g.metric === "ontime" ? pct(v) : count(v);
              return (
                <div key={g.metric} className={s.ring}>
                  <svg viewBox="0 0 92 92" aria-hidden>
                    <circle cx="46" cy="46" r="38" className={s.rbg} />
                    <circle
                      cx="46"
                      cy="46"
                      r="38"
                      className={s.rfg}
                      data-met={frac >= 1 || undefined}
                      style={{ "--to": 239 - 239 * frac } as CSSProperties}
                    />
                  </svg>
                  <div className={s.rctr}>
                    <b>{val(g.value)}</b>
                    <span>of {val(g.target)}</span>
                  </div>
                  <span className={s.rl}>{GOAL_WORDS[g.metric]}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className={s.tiles}>
        {tiles.map((t, i) => {
          const v = shown(t, currency);
          return (
            <div
              key={t.id}
              className={a.tile}
              style={{ "--i": i } as CSSProperties}
              title={METRICS[t.id].info}
            >
              <div className={a.tileLabel}>{t.words}</div>
              <div className={a.tileValue}>
                {v.v}
                {v.unit && <small>{v.unit}</small>}
              </div>
              <Chip trend={compare ? t.trend : null} />
            </div>
          );
        })}
      </div>

      <div className={s.r3}>
        <Card
          title="Your follow-ups"
          sub="Due now and next"
          right={
            me.followUps.ontime !== null ? (
              <span className={a.chip} data-tone={me.followUps.ontime >= 0.9 ? "good" : "flat"}>
                {pct(me.followUps.ontime)} on time
              </span>
            ) : undefined
          }
        >
          {me.followUps.next.length === 0 ? (
            <p className={a.empty}>Nothing due. LUME will let you know when there is.</p>
          ) : (
            <ul className={s.fu}>
              {me.followUps.next.map((f) => {
                const due = dueWords(f.dueAt, timezone, now);
                return (
                  <li key={f.id}>
                    <Link href={`/leads?lead=${f.leadId}`} className={s.fuRow}>
                      <Avatar name={f.leadName} size={30} />
                      <span className={s.fuWho}>
                        <b>{f.leadName}</b>
                        <span>{f.title}</span>
                      </span>
                      <span className={s.due} data-late={due.late || undefined}>
                        {due.text}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Your funnel" sub={`Your leads that arrived ${rangeWords}`}>
          {!me.funnel.stages.length ? (
            <p className={a.empty}>No leads of yours arrived {rangeWords}.</p>
          ) : (
            <>
              <div className={s.fn}>
                {me.funnel.stages.map((st, i) => (
                  <div key={st.id} className={s.fnr}>
                    <span>{st.name}</span>
                    <span className={s.fnt}>
                      <i
                        data-last={i === me.funnel.stages.length - 1 || undefined}
                        style={{ width: `${Math.max(2, (st.share ?? 0) * 100)}%`, "--i": i } as CSSProperties}
                      />
                    </span>
                    <b>{st.share === null ? "—" : pct(st.share, st.share < 0.1 ? 1 : 0)}</b>
                  </div>
                ))}
              </div>
              <div className={s.fnFoot}>
                <span>Your win rate {me.funnel.myWinRate === null ? "—" : pct(me.funnel.myWinRate, 1)}</span>
                {me.funnel.businessWinRate !== null && (
                  <span>The business’s {pct(me.funnel.businessWinRate, 1)}</span>
                )}
              </div>
            </>
          )}
        </Card>

        <Card title="When your leads reply" sub="By day of the week">
          {!real.length ? (
            <p className={a.empty}>Too few messages logged yet to say which days your leads reply.</p>
          ) : (
            <>
              <div
                className={s.days}
                role="img"
                aria-label={days
                  .map((d) => `${DAY[d.dow]}: ${d.rate === null || d.tooFew ? "too few" : pct(d.rate)}`)
                  .join(", ")}
              >
                {days.map((d, i) => (
                  <div key={d.dow} className={s.day} data-best={d === bestDay || undefined}>
                    <span className={s.dbar}>
                      <i
                        style={
                          {
                            height: `${d.tooFew || d.rate === null ? 4 : Math.max(4, (d.rate / most) * 100)}%`,
                            "--i": i,
                          } as CSSProperties
                        }
                        data-thin={d.tooFew || undefined}
                      />
                    </span>
                    <b>{d.tooFew || d.rate === null ? "—" : pct(d.rate)}</b>
                    <span>{DAY3[d.dow]}</span>
                  </div>
                ))}
              </div>
              {bestDay && worstDay && bestDay !== worstDay && (
                <div className={s.ins}>
                  <span className={s.spk} aria-hidden>
                    <img src="/lume-mark.png" alt="" />
                  </span>
                  <div>
                    <b>Your {DAY[bestDay.dow]}s are your best</b>
                    <p>
                      {pct(bestDay.rate!)} of your {DAY[bestDay.dow]} messages got a reply.{" "}
                      {DAY[worstDay.dow]}s, {pct(worstDay.rate!)}.
                    </p>
                  </div>
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </>
  );
}
