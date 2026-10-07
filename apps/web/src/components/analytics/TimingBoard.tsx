"use client";
import Link from "next/link";
import { useState, type CSSProperties } from "react";
import { trend, plural } from "@lume/core/shared";
import { Avatar } from "@/components/ui/Avatar";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import type { Insights, Timing } from "@/lib/analytics/client";
import { count, pct } from "@/lib/analytics/words";
import type { Catalog } from "@/lib/leads/types";
import { Card, Chip, Skeleton } from "./parts";
import a from "./analytics.module.css";
import s from "./timing.module.css";

type View = "replies" | "arrivals" | "booking";
/** Monday first, as the week reads at work; the API counts 0 = Sunday. */
const ROWS = [1, 2, 3, 4, 5, 6, 0];
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hour12 = (h: number) => (h === 0 ? "12 am" : h < 12 ? `${h} am` : h === 12 ? "12 pm" : `${h - 12} pm`);
const short = (h: number) => hour12(h).replace(" ", "");
/** The insights about when to reach people, shown beside the grid. */
const TIMING_INSIGHTS = ["reply_window", "evening_arrivals", "slot_noshow"];
const WORDS: Record<View, { title: string; sub: string; label: string }> = {
  replies: {
    title: "When leads reply",
    sub: "Share of messages answered, by when they were sent",
    label: "Replies",
  },
  arrivals: { title: "When leads arrive", sub: "New leads, by when they came in", label: "Arrivals" },
  booking: {
    title: "Which booked calls are held",
    sub: "Calls held, out of those booked, by when they were set",
    label: "Bookings",
  },
};

/**
 * Timing & meetings (canvas Timing): one week-by-hour grid (replies, arrivals or bookings) in the business's time, its
 * best slot, what LUME noticed about timing, and the meetings: their numbers, what happened to every call booked, and
 * each person's.
 */
export function TimingBoard({
  timing,
  insights,
  catalog,
  timezone,
  compare,
  rangeWords,
  onDrill,
}: {
  timing: Timing | null;
  insights: Insights | null;
  catalog: Catalog;
  timezone: string;
  compare: boolean;
  rangeWords: string;
  onDrill(token: string, title: string): void;
}) {
  if (!timing)
    return (
      <div className={s.tg}>
        <Skeleton h={380} />
        <Skeleton h={380} i={1} />
      </div>
    );
  const noticed =
    insights?.ready === true ? insights.insights.filter((i) => TIMING_INSIGHTS.includes(i.id)) : [];
  return (
    <>
      <div className={s.tg}>
        <Grid timing={timing} timezone={timezone} onDrill={onDrill} />
        <Card title="LUME noticed" sub="When to reach people">
          {noticed.length ? (
            <div className={s.ins}>
              {noticed.slice(0, 3).map((i) => (
                <div key={`${i.id}-${i.subject}`} className={s.insRow}>
                  <span className={s.spk} aria-hidden>
                    <img src="/lume-mark.png" alt="" />
                  </span>
                  <div>
                    <b>{i.title}</b>
                    <p>{i.body}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className={a.empty}>
              Nothing about timing stands out yet. LUME will let you know when a day or an hour does better
              than the rest.
            </p>
          )}
          <p className={s.foot}>Replies count only when your team logs them.</p>
        </Card>
      </div>
      <Meetings
        timing={timing}
        catalog={catalog}
        compare={compare}
        rangeWords={rangeWords}
        onDrill={onDrill}
      />
    </>
  );
}

function Grid({
  timing,
  timezone,
  onDrill,
}: {
  timing: Timing;
  timezone: string;
  onDrill(token: string, title: string): void;
}) {
  // Replies first, as the canvas has it; arrivals when no replies are logged yet (a team that doesn't log them).
  const [view, setView] = useState<View>(() =>
    timing.replies.some((row) => row.some((c) => c.rate !== null && c.n > 0)) ? "replies" : "arrivals",
  );
  const hours = Array.from(
    { length: timing.window.endHour - timing.window.startHour },
    (_, i) => timing.window.startHour + i,
  );
  const value = (dow: number, hour: number): { v: number | null; n: number; thin?: boolean } => {
    if (view === "arrivals") return { v: timing.arrivals[dow]![hour]!, n: timing.arrivals[dow]![hour]! };
    const c = (view === "replies" ? timing.replies : timing.booking)[dow]![hour]!;
    return { v: c.rate, n: c.n, thin: c.tooFew };
  };
  const all = ROWS.flatMap((d) => hours.map((h) => value(d, h).v ?? 0));
  const max = Math.max(0, ...all);
  const empty = all.every((v) => v === 0);
  const best =
    view === "replies"
      ? timing.best.replies
      : view === "booking"
        ? timing.best.booking
        : timing.best.arrivals;
  const show = (x: { v: number | null; n: number }) =>
    view === "arrivals" ? count(x.n) : x.v === null ? "—" : pct(x.v);
  const bestRate = best && "rate" in best ? (best as { rate: number }).rate : null;
  const bestText = best
    ? `Best: ${DAY[best.dow]} ${hour12(best.hour)} · ${bestRate !== null ? pct(bestRate) : plural(best.n, "lead")}`
    : null;
  const outside =
    view === "arrivals"
      ? timing.outside.arrivals
      : view === "replies"
        ? timing.outside.sends
        : timing.outside.booked;
  const tzWords = timezone.split("/").pop()!.replace(/_/g, " ");
  return (
    <Card
      title={WORDS[view].title}
      sub={`${WORDS[view].sub} · ${tzWords} time`}
      right={
        <SegmentedControl
          label="Show"
          value={view}
          options={(Object.keys(WORDS) as View[]).map((v) => ({ value: v, label: WORDS[v].label }))}
          onChange={(v) => setView(v as View)}
        />
      }
    >
      {empty ? (
        <p className={a.empty}>
          {view === "replies"
            ? "No replies logged in this range. Replies count once your team logs them on a lead."
            : view === "booking"
              ? "No calls were booked in this range."
              : "No leads arrived in this range."}
        </p>
      ) : (
        <>
          <div
            className={s.hm}
            role="table"
            aria-label={WORDS[view].title}
            style={{ gridTemplateColumns: `38px repeat(${hours.length}, minmax(0, 1fr))` }}
          >
            <div role="row" className={s.row}>
              <span role="columnheader" />
              {hours.map((h) => (
                <span key={h} role="columnheader" className={s.hh}>
                  {(h - timing.window.startHour) % 2 === 1 ? short(h) : ""}
                  <span className={s.srOnly}>{hour12(h)}</span>
                </span>
              ))}
            </div>
            {ROWS.map((d, i) => (
              <div key={d} role="row" className={s.row}>
                <span role="rowheader" className={s.rh}>
                  {DAY[d]}
                </span>
                {hours.map((h, j) => {
                  const x = value(d, h);
                  const k = max ? (x.v ?? 0) / max : 0;
                  const cell = timing.cells[view][d]?.[h];
                  const isBest = best?.dow === d && best.hour === h;
                  return (
                    <span key={h} role="cell">
                      <button
                        type="button"
                        className={s.cell}
                        data-best={isBest || undefined}
                        data-thin={x.thin || undefined}
                        disabled={!cell?.drill}
                        title={`${DAY_LONG[d]} ${hour12(h)}: ${show(x)}${view === "arrivals" ? "" : ` of ${count(x.n)}`}. Click to see these leads`}
                        aria-label={`${DAY_LONG[d]} ${hour12(h)}: ${show(x)}${view === "arrivals" ? " leads" : ` of ${count(x.n)}`}`}
                        style={
                          {
                            "--d": i + j,
                            background: x.thin
                              ? "var(--sunk)"
                              : `color-mix(in srgb, var(--accent) ${Math.round(8 + k * 82)}%, var(--sunk))`,
                          } as CSSProperties
                        }
                        onClick={() => cell?.drill && onDrill(cell.drill, `${DAY_LONG[d]}, ${hour12(h)}`)}
                      />
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
          <div className={s.legend}>
            <span>Quiet</span>
            <i aria-hidden />
            <span>Busy</span>
            {bestText && (
              <b className={s.best}>
                <span aria-hidden />
                {bestText}
              </b>
            )}
          </div>
          {outside > 0 && (
            <p className={s.note}>
              {count(outside)} more outside {hour12(timing.window.startHour)} –{" "}
              {hour12(timing.window.endHour)}.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function Meetings({
  timing,
  catalog,
  compare,
  rangeWords,
  onDrill,
}: {
  timing: Timing;
  catalog: Catalog;
  compare: boolean;
  rangeWords: string;
  onDrill(token: string, title: string): void;
}) {
  const m = timing.meetings;
  const k = m.kpis;
  const p = k.previous;
  const tiles = [
    { label: "Booked", v: count(k.booked), t: trend(k.booked, p.booked) },
    { label: "Held", v: count(k.held), t: trend(k.held, p.held), drill: m.drill.held },
    {
      label: "No-show rate",
      v: k.noShowRate === null ? "—" : pct(k.noShowRate, 1),
      t:
        k.noShowRate !== null && p.noShowRate !== null
          ? trend(k.noShowRate, p.noShowRate, { kind: "pts", good: "down" })
          : null,
      drill: m.drill.no_show,
    },
    {
      label: "Cancelled",
      v: count(k.cancelled),
      t: trend(k.cancelled, p.cancelled, { good: "down" }),
      drill: m.drill.cancelled,
    },
  ];
  const f = m.flow;
  const parts = [
    { key: "held", label: "Held", long: "Held", n: f.held, color: "var(--accent)", drill: m.drill.held },
    {
      key: "noshow",
      label: "No-show",
      long: "They didn’t show",
      n: f.noShow,
      color: "var(--warn)",
      drill: m.drill.no_show,
    },
    {
      key: "cancelled",
      label: "Cancelled",
      long: "Cancelled",
      n: f.cancelled,
      color: "#8a94a6",
      drill: m.drill.cancelled,
    },
    { key: "moved", label: "Moved", long: "Moved to another time", n: f.rescheduled, color: "#c7cdd8" },
    { key: "ahead", label: "Ahead", long: "Still ahead", n: f.upcoming, color: "var(--sky)" },
  ].filter((x) => x.n > 0);
  const total = parts.reduce((x, y) => x + y.n, 0);
  const people = [...m.people].sort(
    (x, y) => y.held + y.noShow + y.cancelled - (x.held + x.noShow + x.cancelled),
  );
  const most = Math.max(1, ...people.map((x) => x.held + x.noShow + x.cancelled));
  const color = (id: string) => catalog.people.find((x) => x.id === id)?.avatar?.color;
  return (
    <section
      className={`${a.card} ${s.meetings}`}
      style={{ "--i": 2 } as CSSProperties}
      aria-label="Meetings"
    >
      <div className={a.cardHead}>
        <div>
          <h3>Meetings</h3>
          <div className={a.sub}>Calls with leads {rangeWords}, from Calendly and your calendars</div>
        </div>
        <Link className={s.cal} href="/calendar">
          Calendar
          <svg viewBox="0 0 12 12" aria-hidden>
            <path d="m4.5 2.5 3.5 3.5-3.5 3.5" />
          </svg>
        </Link>
      </div>
      {!k.booked && !total ? (
        <p className={a.empty}>No calls with leads {rangeWords}.</p>
      ) : (
        <>
          <div className={s.mk}>
            {tiles.map((t) => (
              <button
                key={t.label}
                type="button"
                className={s.mt}
                disabled={!t.drill}
                aria-label={`${t.label}: ${t.v}${t.drill ? ". See the leads." : ""}`}
                onClick={() => t.drill && onDrill(t.drill, `Calls: ${t.label.toLowerCase()}`)}
              >
                <span>{t.label}</span>
                <b>{t.v}</b>
                <Chip trend={compare ? t.t : null} />
              </button>
            ))}
          </div>
          <div className={s.two}>
            <div>
              <h4 className={s.h4}>What happened to every call booked</h4>
              {total > 0 && (
                <>
                  <div
                    className={s.flow}
                    role="img"
                    aria-label={parts.map((x) => `${x.long}: ${x.n}`).join(", ")}
                  >
                    {parts.map((x, i) => (
                      <button
                        key={x.key}
                        type="button"
                        className={s.fl}
                        disabled={!x.drill}
                        tabIndex={x.drill ? 0 : -1}
                        title={`${x.long}: ${count(x.n)}`}
                        style={{ "--f": x.n, "--i": i, background: x.color } as CSSProperties}
                        onClick={() => x.drill && onDrill(x.drill, `Calls: ${x.long.toLowerCase()}`)}
                      >
                        {x.n / total > 0.12 ? `${x.label} ${count(x.n)}` : ""}
                      </button>
                    ))}
                  </div>
                  <div className={s.flLegend}>
                    {parts.map((x) => (
                      <span key={x.key}>
                        <i style={{ background: x.color }} />
                        {x.long} <b>{count(x.n)}</b>
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
            <div>
              <h4 className={s.h4}>Per person · held, no-shows, cancelled</h4>
              <div className={s.pp}>
                {people.slice(0, 6).map((x) => {
                  const all = x.held + x.noShow + x.cancelled;
                  return (
                    <div key={x.id} className={s.ppr}>
                      <Avatar name={x.name} size={26} {...(color(x.id) ? { color: color(x.id)! } : {})} />
                      <span className={s.ppn}>{x.name}</span>
                      <span className={s.tr9} style={{ width: `${(all / most) * 100}%` }} aria-hidden>
                        <i style={{ flex: x.held, background: "var(--accent)" }} />
                        <i style={{ flex: x.noShow, background: "var(--warn)" }} />
                        <i style={{ flex: x.cancelled, background: "#8a94a6" }} />
                      </span>
                      <span className={s.ppt}>
                        {count(x.held)} of {count(all)}
                        <span className={s.srOnly}>
                          {" "}
                          held; {x.noShow} no-shows, {x.cancelled} cancelled
                        </span>
                      </span>
                    </div>
                  );
                })}
                {!people.length && <p className={a.empty}>No one’s calls yet.</p>}
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
