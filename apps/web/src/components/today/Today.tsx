"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSound } from "@/components/feedback/SoundProvider";
import { SNOOZE } from "@/components/tasks/NextFollowUp";
import { Popover } from "@/components/ui/Popover";
import { SPRINGS, toMotion } from "@/lib/motion";
import { notificationsClient } from "@/lib/notifications/client";
import { useStream } from "@/lib/notifications/stream";
import { tasksClient } from "@/lib/tasks/client";
import { timezoneOf, whenInWords } from "@/lib/tasks/format";
import type { TaskView, TodayView } from "@/lib/tasks/types";
import s from "./today.module.css";

type Group = { id: "overdue" | "soon" | "later"; label: string };
const GROUPS: Group[] = [
  { id: "overdue", label: "Overdue" },
  { id: "soon", label: "Due soon" },
  { id: "later", label: "Later today" },
];

const localHour = (tz: string) =>
  Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date()),
  );
const greeting = (tz: string) => {
  const h = localHour(tz);
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
};
const dateLine = (tz: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(
    new Date(),
  );
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

/**
 * Today (Phase 3 spec §6): whom to start with, how the day is going, and every follow-up that needs you,
 * grouped in your own day — each one a tick away from done. New reminders bring it up to date live.
 */
export function Today({ name, tz: userTz }: { name: string; tz: string | null }) {
  const tz = timezoneOf(userTz);
  const reduce = useReducedMotion();
  const sound = useSound();
  const [v, setV] = useState<TodayView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);
  const celebrated = useRef(false);

  const load = useCallback(async () => {
    const r = await tasksClient.today();
    if (!r.ok) return setError(r.message);
    setError(null);
    setV(r.data);
  }, []);
  useEffect(() => {
    void load();
    void notificationsClient.readAll(); // Today is where the bell's news is read
  }, [load]);
  useStream(() => void load());

  const remaining = v ? v.overdue.length + v.soon.length + v.later.length : 0;
  // Everything due today done (and there was something): All clear, with its sound once a day.
  useEffect(() => {
    if (!v || v.total === 0 || remaining > 0 || celebrated.current) return;
    celebrated.current = true;
    setCleared(true);
    if (firstClearToday(tz)) sound.play("cleared");
  }, [v, remaining, sound, tz]);

  if (error && !v)
    return (
      <p role="alert" className={s.error}>
        {error}
      </p>
    );
  if (!v) return <div className={s.page} aria-busy="true" />;

  const done = async (t: TaskView) => {
    const r = await tasksClient.done(t.id);
    if (!r.ok) return setError(r.message);
    const last = r.data.clearedToday;
    if (last) {
      celebrated.current = true;
      setCleared(true);
      if (firstClearToday(tz)) sound.play("cleared");
    } else sound.play("done");
    setV(
      (cur) =>
        cur && {
          ...cur,
          overdue: cur.overdue.filter((x) => x.id !== t.id),
          soon: cur.soon.filter((x) => x.id !== t.id),
          later: cur.later.filter((x) => x.id !== t.id),
          done: cur.done + 1,
        },
    );
  };
  const snooze = async (t: TaskView, preset: (typeof SNOOZE)[number]["preset"]) => {
    const r = await tasksClient.snooze(t.id, { preset });
    if (!r.ok) return setError(r.message);
    await load();
  };

  const first = name.split(" ")[0] || name;
  const oldest = v.overdue[0];
  const brief =
    v.total === 0
      ? "Nothing's due today."
      : oldest
        ? `${oldest.leadName} has been waiting since ${whenInWords(oldest.dueAt, new Date(), tz).replace(" (overdue)", "")}, so start there.`
        : remaining
          ? `Nothing's overdue. ${remaining === 1 ? "One follow-up" : `${remaining} follow-ups`} still to go today.`
          : "Everything due today is done.";

  return (
    <div className={s.page}>
      <section className={s.hero}>
        <div>
          <p className={s.date}>{dateLine(tz)}</p>
          <h1 className={s.greet}>
            {greeting(tz)}, {first}
          </h1>
          <p className={s.brief}>{brief}</p>
        </div>
        {v.total > 0 && <Ring done={v.done} total={v.total} reduce={!!reduce} />}
      </section>

      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}

      {cleared && remaining === 0 ? (
        <motion.section
          className={s.clear}
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={toMotion(SPRINGS.bounce)}
        >
          <motion.img
            src="/lume-mark.png"
            alt=""
            width={56}
            height={56}
            initial={reduce ? false : { rotate: -120, opacity: 0 }}
            animate={{ rotate: 0, opacity: 1 }}
            transition={toMotion(SPRINGS.bounce)}
          />
          <h2 className={s.clearTitle}>All clear</h2>
          <p className={s.brief}>
            Every follow-up due today is done. LUME will bring the next ones back when they're due.
          </p>
        </motion.section>
      ) : remaining === 0 ? null : (
        <section aria-labelledby="up-next">
          <h2 id="up-next" className={s.secTitle}>
            Up next
          </h2>
          {GROUPS.map((g) =>
            v[g.id].length ? (
              <div key={g.id} className={s.group}>
                <h3 className={s.groupHead} data-group={g.id}>
                  <i aria-hidden />
                  {g.label}
                  <span className={s.count}>{v[g.id].length}</span>
                </h3>
                <ul className={s.rows} aria-label={g.label}>
                  <AnimatePresence initial={false}>
                    {v[g.id].map((t) => (
                      <motion.li
                        key={t.id}
                        layout={!reduce}
                        className={s.row}
                        exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0, x: 24 }}
                        transition={toMotion(SPRINGS.default)}
                      >
                        <button
                          type="button"
                          className={s.tick}
                          aria-label={`Done: ${t.title} — ${t.leadName}`}
                          onClick={() => void done(t)}
                        >
                          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
                            <path
                              d="M3.5 8.5 6.5 11.5 12.5 4.5"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                        <span className={s.avatar} aria-hidden>
                          {initials(t.leadName)}
                        </span>
                        <span className={s.who}>
                          <Link href={`/leads?lead=${t.leadId}`} className={s.name}>
                            {t.leadName}
                          </Link>
                          <span className={s.what}>{t.title}</span>
                        </span>
                        <span className={s.when} data-group={g.id} data-volatile>
                          {whenInWords(t.dueAt, new Date(), tz)}
                        </span>
                        <span className={s.acts}>
                          <Popover
                            label={`Snooze ${t.title} — ${t.leadName}`}
                            trigger="Snooze"
                            triggerClassName={s.act}
                            role="menu"
                            align="end"
                          >
                            {(close) => (
                              <div className={s.menu}>
                                {SNOOZE.map((o) => (
                                  <button
                                    key={o.preset}
                                    type="button"
                                    role="menuitem"
                                    className={s.menuItem}
                                    onClick={() => {
                                      close();
                                      void snooze(t, o.preset);
                                    }}
                                  >
                                    {o.label}
                                  </button>
                                ))}
                              </div>
                            )}
                          </Popover>
                        </span>
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              </div>
            ) : null,
          )}
        </section>
      )}

      {v.needsYou && (v.needsYou.unassigned > 0 || v.needsYou.sources.length > 0) && (
        <section aria-labelledby="needs-you" className={s.needs}>
          <h2 id="needs-you" className={s.secTitle}>
            Needs you
          </h2>
          <ul className={s.needsList}>
            {v.needsYou.unassigned > 0 && (
              <li>
                <Link href="/leads?ownerId=none">
                  {v.needsYou.unassigned === 1
                    ? "1 new lead has no one yet"
                    : `${v.needsYou.unassigned} new leads have no one yet`}
                </Link>
              </li>
            )}
            {v.needsYou.sources.map((x) => (
              <li key={x.id}>
                <Link
                  href={
                    x.type === "webhook"
                      ? `/settings/integrations/webhooks/${x.id}`
                      : `/settings/integrations/${x.id}`
                  }
                >
                  {x.name} needs attention
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/** "3 / 7 cleared today", as a ring that fills with a spring. */
function Ring({ done, total, reduce }: { done: number; total: number; reduce: boolean }) {
  const C = 2 * Math.PI * 27;
  const part = total ? Math.min(1, done / total) : 0;
  return (
    <div className={s.ring}>
      <div className={s.ringText}>
        <span className={s.ringBig}>
          {done} / {total}
        </span>
        <span className={s.ringCap}>cleared today</span>
      </div>
      <svg
        viewBox="0 0 64 64"
        width="64"
        height="64"
        role="img"
        aria-label={`${done} of ${total} cleared today`}
      >
        <circle className={s.ringTrack} cx="32" cy="32" r="27" fill="none" strokeWidth="6" />
        <motion.circle
          className={s.ringValue}
          cx="32"
          cy="32"
          r="27"
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={C}
          initial={false}
          animate={{ strokeDashoffset: C * (1 - part) }}
          transition={reduce ? { duration: 0 } : toMotion(SPRINGS.soft)}
        />
      </svg>
    </div>
  );
}
