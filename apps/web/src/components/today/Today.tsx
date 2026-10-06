"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useSound } from "@/components/feedback/SoundProvider";
import { LogOutcome } from "@/components/calendar/LogOutcome";
import { ResumeRun } from "@/components/queue/ResumeRun";
import { Popover } from "@/components/ui/Popover";
import { longDate } from "@/lib/dates";
import { useStream } from "@/lib/notifications/stream";
import { tasksClient } from "@/lib/tasks/client";
import { timezoneOf } from "@/lib/tasks/format";
import type { SnoozePreset, TaskView, TodayMeeting, TodayView } from "@/lib/tasks/types";
import { brief, callsLeft } from "@/lib/today/brief";
import { todayClient } from "@/lib/today/client";
import type { Tiles as TilesData } from "@/lib/today/types";
import { DayTile } from "./DayTile";
import { TileSkeletons, Tiles } from "./Tiles";
import { WorkTile } from "./WorkTile";
import s from "./today.module.css";

const localHour = (tz: string) =>
  Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date()),
  );
const greeting = (tz: string) => {
  const h = localHour(tz);
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
};
const localDay = (tz: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

/** The celebration plays once a day, however often Today is opened afterwards (sound policy: achievements). */
function firstClearToday(tz: string): boolean {
  const key = `lume:cleared:${localDay(tz)}`;
  try {
    if (localStorage.getItem(key)) return false;
    localStorage.setItem(key, "1");
  } catch {
    // no storage (a private window): celebrate, it's still an achievement
  }
  return true;
}

/** The tiles refresh every minute, and on news from the stream, but not more than once every 15 seconds. */
const REFRESH_MS = 60_000;
const SOONEST_MS = 15_000;

/**
 * Today, the control centre (spec 2026-10-05-today-control-centre-design.md; canvas P7w9C2GFBNVvdn3ANBLt9N v3):
 * LUME says where to start; Your day and Up next hold the work; six tiles say how the business — or, for someone
 * who sees only their own, how they — are doing, each counted as it is everywhere else in LUME and each opening its
 * page. New reminders and leads bring it up to date live.
 */
export function Today({
  name,
  tz: userTz,
  canMessage = false,
  canQueue = false,
  currency,
  own = false,
  canSetUp = false,
}: {
  name: string;
  tz: string | null;
  /** WhatsApp on each row, for someone who may send messages (4A). */
  canMessage?: boolean;
  /** A send queue left open, picked up again here with why it paused (4C); nothing shows without one. */
  canQueue?: boolean;
  /** The business's currency, for money on the tiles. */
  currency: string;
  /** The viewer sees only their own leads: "Your leads", "Your pipeline". */
  own?: boolean;
  /** May set LUME up (settings.manage): a business with no leads yet gets the setup steps. */
  canSetUp?: boolean;
}) {
  const tz = timezoneOf(userTz);
  const sound = useSound();
  const [v, setV] = useState<TodayView | null>(null);
  const [tiles, setTiles] = useState<TilesData | null>(null);
  const [tilesFailed, setTilesFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticking, setTicking] = useState<Set<string>>(new Set());
  const [nods, setNods] = useState(0);
  const [logging, setLogging] = useState<TodayMeeting | null>(null);
  const [now, setNow] = useState(() => new Date());
  const lastTiles = useRef(0);

  const load = useCallback(async () => {
    const r = await tasksClient.today();
    if (!r.ok) return setError(r.message);
    setError(null);
    setV(r.data);
    setNow(new Date());
  }, []);
  const loadTiles = useCallback(async (force = false) => {
    if (!force && Date.now() - lastTiles.current < SOONEST_MS) return;
    lastTiles.current = Date.now();
    const r = await todayClient.tiles();
    if (r.ok) {
      setTiles(r.data);
      setTilesFailed(false);
    } else setTilesFailed(true);
  }, []);
  useEffect(() => {
    void load();
    void loadTiles(true);
    const t = setInterval(() => {
      setNow(new Date());
      void loadTiles(true);
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load, loadTiles]);
  useStream(() => {
    void load();
    void loadTiles();
  });

  if (error && !v)
    return (
      <p role="alert" className={s.error}>
        {error}
      </p>
    );

  const remaining = v ? v.overdue.length + v.soon.length + v.later.length : 0;
  const owedCalls = v
    ? (v.meetings ?? []).filter((m) => m.status === "scheduled" && Date.parse(m.endsAt) <= now.getTime())
    : [];
  const toCome = v ? callsLeft(v.meetings, now) : [];
  // All clear: there was something today, and every follow-up and call is done.
  const clear = !!v && v.total > 0 && remaining === 0 && !toCome.length && !owedCalls.length;
  const nothing =
    !!v &&
    v.total === 0 &&
    !(v.meetings ?? []).some((m) => m.status === "scheduled" || m.status === "completed");
  const firstDay =
    canSetUp &&
    !!tiles &&
    (tiles.pipeline?.open ?? 0) === 0 &&
    (tiles.leads?.today ?? 0) === 0 &&
    (tiles.pipeline?.wonThisMonth ?? 0) === 0;
  const said = v ? brief(v, now, tz) : null;

  const drop = (t: TaskView) =>
    setV(
      (cur) =>
        cur && {
          ...cur,
          overdue: cur.overdue.filter((x) => x.id !== t.id),
          soon: cur.soon.filter((x) => x.id !== t.id),
          later: cur.later.filter((x) => x.id !== t.id),
          done: cur.done + 1,
          doneToday: [
            ...(cur.doneToday ?? []),
            { id: t.id, title: t.title, dueAt: t.dueAt, leadId: t.leadId, leadName: t.leadName },
          ],
        },
    );
  const done = async (t: TaskView) => {
    setTicking((x) => new Set(x).add(t.id));
    const r = await tasksClient.done(t.id);
    setTicking((x) => {
      const n = new Set(x);
      n.delete(t.id);
      return n;
    });
    if (!r.ok) return setError(r.message);
    if (r.data.clearedToday && firstClearToday(tz)) sound.play("cleared");
    else sound.play("done");
    // LUME's mark turns one petal for every follow-up done.
    setNods((n) => n + 1);
    void loadTiles();
    // A repeat made the next one: it may be due today, so ask again rather than guess.
    if (r.data.next) return void (await load());
    drop(t);
  };
  const sent = (t: TaskView) => {
    setNods((n) => n + 1);
    drop(t);
    void load();
  };
  const snooze = async (t: TaskView, preset: SnoozePreset) => {
    const r = await tasksClient.snooze(t.id, { preset });
    if (!r.ok) return setError(r.message);
    await load();
  };

  const needs = v?.needsYou;
  const needRows = needs
    ? [
        ...(needs.unassigned > 0
          ? [
              {
                key: "unassigned",
                tone: "blue",
                title:
                  needs.unassigned === 1
                    ? "1 new lead has no one yet"
                    : `${needs.unassigned.toLocaleString("en-US")} new leads have no one yet`,
                sub: needs.unassignedOldest ? `The oldest came in ${ago(needs.unassignedOldest, now)}` : "",
                href: "/leads?owner=none",
                act: "Assign",
              },
            ]
          : []),
        ...needs.sources.map((x) => ({
          key: x.id,
          tone: "amber",
          title: `${x.name} needs attention`,
          sub: "LUME can't read new leads from it right now",
          href:
            x.type === "webhook"
              ? `/settings/integrations/webhooks/${x.id}`
              : `/settings/integrations/${x.id}`,
          act: "Fix",
        })),
        ...(needs.alerts
          ? [
              {
                key: "alerts",
                tone: "red",
                title:
                  needs.alerts === 1
                    ? "1 security alert needs a look"
                    : `${needs.alerts} security alerts need a look`,
                sub: "Sign-ins and changes to check",
                href: "/settings/security",
                act: "Review",
              },
            ]
          : []),
      ]
    : [];

  return (
    <div className={s.page}>
      {/* LUME speaks: where to start, in one line. */}
      <header className={s.hdr}>
        <div
          className={s.mark}
          data-nod={nods ? (nods % 2 ? "1" : "2") : undefined}
          data-thinking={!v || undefined}
        >
          <img src="/lume-mark.png" alt="" style={{ transform: `rotate(${nods * 60}deg)` }} />
        </div>
        <div style={{ minWidth: 0 }}>
          <h1 className={s.hello}>
            <span data-volatile>{greeting(tz)}</span>, {name.split(" ")[0] || name}
          </h1>
          {said ? (
            <p className={s.say} data-live-count>
              {said.parts.map((p, i) =>
                p.leadId || p.tone ? (
                  <Link key={i} href={p.leadId ? `/leads?lead=${p.leadId}` : "/calendar"} data-tone={p.tone}>
                    {p.text}
                  </Link>
                ) : (
                  <span key={i}>{p.text}</span>
                ),
              )}
            </p>
          ) : (
            <span className={s.sk} style={{ width: 360, height: 13, marginTop: 9 }} aria-hidden />
          )}
        </div>
        <div className={s.hr}>
          <span className={s.when} data-live-count>
            {longDate(now, tz)}
          </span>
          <span
            className={s.live}
            title="Up to date: Today changes as things happen, and its numbers refresh every minute"
          >
            <i aria-hidden />
            Live
          </span>
          {needs && (
            <Popover
              label="Needs you"
              trigger={
                needRows.length ? (
                  <>
                    Needs you<em>{needRows.length}</em>
                  </>
                ) : (
                  "All good"
                )
              }
              triggerLabel={needRows.length ? `Needs you, ${needRows.length}` : "Nothing needs you"}
              triggerClassName={s.needsBtn}
              align="end"
              disabled={!needRows.length}
            >
              <div className={s.npop}>
                {needRows.map((r) => (
                  <div key={r.key} className={s.nitem}>
                    <span className={s.ic} data-tone={r.tone} aria-hidden>
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        {r.tone === "red" ? (
                          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM12 8v4M12 16h.01" />
                        ) : r.tone === "amber" ? (
                          <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                        ) : (
                          <path d="M10 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M2 21v-1a7 7 0 0 1 11-5.7M19 15v6M16 18h6" />
                        )}
                      </svg>
                    </span>
                    <div>
                      <b>{r.title}</b>
                      {r.sub && <span className={s.sub}>{r.sub}</span>}
                    </div>
                    <Link className={s.go} href={r.href}>
                      {r.act}
                    </Link>
                  </div>
                ))}
              </div>
            </Popover>
          )}
        </div>
      </header>
      {canQueue && <ResumeRun variant="card" />}
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}

      <div className={s.grid}>
        {v ? (
          <>
            <DayTile v={v} now={now} tz={tz} />
            <WorkTile
              v={v}
              now={now}
              tz={tz}
              canMessage={canMessage}
              ticking={ticking}
              onDone={(t) => void done(t)}
              onSent={sent}
              onSnooze={(t, p) => void snooze(t, p)}
              onLogOutcome={setLogging}
              clear={clear}
              empty={nothing ? (firstDay ? "firstDay" : "quiet") : null}
            />
          </>
        ) : (
          <>
            <div className={`${s.tl} ${s.dayArea}`} aria-busy>
              <span className={s.sk} style={{ width: 90, height: 14 }} />
              <span className={s.sk} style={{ height: 3, marginTop: 62 }} />
              <span className={s.sk} style={{ height: 46, marginTop: 40, borderRadius: 14 }} />
            </div>
            <div className={`${s.tl} ${s.workArea}`} aria-busy>
              <span className={s.sk} style={{ width: 90, height: 14 }} />
              {Array.from({ length: 6 }, (_, i) => (
                <span key={i} className={s.sk} style={{ height: 30, marginTop: i ? 16 : 22 }} />
              ))}
            </div>
          </>
        )}
        <div className={s.tiles} aria-label="How it's going" role="region" aria-busy={!tiles || undefined}>
          {tiles ? (
            <Tiles tiles={tiles} currency={currency} own={own} unassigned={needs?.unassigned} />
          ) : tilesFailed ? (
            <div className={s.tl} style={{ gridColumn: "1 / 3", "--i": 2 } as CSSProperties}>
              <p className={s.quiet}>
                LUME couldn&apos;t load these numbers.{" "}
                <button type="button" className={s.more} onClick={() => void loadTiles(true)}>
                  Try again
                </button>
              </p>
            </div>
          ) : (
            <TileSkeletons />
          )}
        </div>
      </div>

      {logging && (
        <LogOutcome
          meeting={logging}
          tz={tz}
          onClose={() => setLogging(null)}
          onDone={() => {
            setLogging(null);
            void load();
            void loadTiles(true);
          }}
        />
      )}
    </div>
  );
}

/** "12 min ago", "2 hours ago", "3 days ago". */
function ago(iso: string, now: Date): string {
  const m = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (m < 60) return `${Math.max(1, m)} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
}
