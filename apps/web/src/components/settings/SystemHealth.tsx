"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { healthClient, type Health } from "@/lib/settings/health";
import { SPRINGS, toMotion } from "@/lib/motion";
import h from "./health.module.css";

const EVERY_MS = 30_000;

/** How long before `now` a moment was, as people say it: "32 s ago", "5 min ago", "3 h ago", "2 days ago". */
function ago(iso: string | null, now: string): string {
  if (!iso) return "not yet";
  const s = Math.max(0, Math.round((Date.parse(now) - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86_400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}
const SOURCE_STATUS: Record<string, string> = {
  active: "syncing",
  paused: "paused",
  needs_attention: "needs attention",
};

/**
 * Settings → System health (3C Task 7; report §10.4.7): one look says whether LUME is keeping its promises —
 * every reminder firing, every email going, every source syncing, backups restorable. It checks again every
 * 30 s while it's on screen (and at once when it comes back), with no layout jump.
 */
export function SystemHealth({ initial }: { initial: Health }) {
  const reduce = useReducedMotion();
  const [health, setHealth] = useState(initial);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const check = async () => {
      const r = await healthClient.get();
      if (r.ok) setHealth(r.data);
    };
    const start = () => {
      if (timer) return;
      timer = setInterval(() => void check(), EVERY_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") return stop();
      void check();
      start();
    };
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const { problems, checkedAt: now } = health;
  const fine = problems.length === 0;
  return (
    <div className={h.page}>
      <section className={h.headline} data-fine={fine || undefined} aria-live="polite">
        <span className={h.glyph} aria-hidden>
          <svg viewBox="0 0 24 24" width="22" height="22">
            {fine ? (
              <path
                d="M6 12.5l4 4 8-9"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : (
              <path
                d="M12 7v6m0 3.5v.1"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            )}
          </svg>
        </span>
        <div>
          <h2 className={h.title}>
            {fine
              ? "Everything is running"
              : `${problems.length} ${problems.length === 1 ? "thing needs" : "things need"} a look`}
          </h2>
          <p className={h.checked}>
            Checked at{" "}
            <time data-volatile dateTime={now}>
              {new Intl.DateTimeFormat("en-GB", {
                hour: "2-digit",
                minute: "2-digit",
                hourCycle: "h23",
              }).format(new Date(now))}
            </time>
            . LUME looks again every 30 seconds.
          </p>
        </div>
      </section>
      <AnimatePresence initial={false}>
        {!fine && (
          <motion.ul
            className={h.problems}
            aria-label="What needs a look"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={toMotion(SPRINGS.default)}
          >
            {problems.map((p) => (
              <li key={p.key}>{p.words}</li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
      <div className={h.grid}>
        <Card title="Follow-up reminders" warn={health.followUps.late > 0}>
          <Figure n={health.followUps.pending} label="waiting for their time" />
          <Figure n={health.followUps.late} label="late" warn={health.followUps.late > 0} />
          <Figure n={health.followUps.firedToday} label="sent today" />
          <Line label="Last checked">{ago(health.followUps.lastSweepAt, now)}</Line>
        </Card>
        <Card title="Background jobs" warn={health.queue.failed24h > 0}>
          <Figure n={health.queue.waiting} label="waiting" />
          <Figure n={health.queue.active} label="running" />
          <Figure n={health.queue.failed24h} label="failed today" warn={health.queue.failed24h > 0} />
        </Card>
        <Card title="Morning emails" warn={health.digest.failures24h >= 3}>
          <Figure n={health.digest.sentToday} label="sent today" />
          <Figure
            n={health.digest.failures24h}
            label="failed in a day"
            warn={health.digest.failures24h > 0}
          />
          <Line label="Last one">{ago(health.digest.lastSentAt, now)}</Line>
        </Card>
        <Card title="Leads gone quiet">
          {health.noTouch.enabled ? (
            <>
              <Figure n={health.noTouch.createdToday} label="brought back today" />
              <Line label="Last time">{ago(health.noTouch.lastRunAt, now)}</Line>
            </>
          ) : (
            <p className={h.off}>Off. Switch it on in Follow-ups.</p>
          )}
        </Card>
        <Card title="Sources" warn={health.sources.some((x) => x.status === "needs_attention")}>
          {health.sources.length ? (
            <ul className={h.sources}>
              {health.sources.map((x) => (
                <li key={x.id} data-warn={x.status === "needs_attention" || undefined}>
                  <span className={h.sourceName}>{x.name}</span>
                  <span className={h.sourceState}>
                    {SOURCE_STATUS[x.status] ?? x.status}
                    {x.lastSyncAt ? ` · ${ago(x.lastSyncAt, now)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className={h.off}>No sheets or webhooks yet.</p>
          )}
        </Card>
        <Card title="Backups" warn={health.restoreTest.ok === false}>
          <Line label="Last restore test">
            {health.restoreTest.at
              ? `${health.restoreTest.ok ? "passed" : "failed"}, ${ago(health.restoreTest.at, now)}`
              : "not run yet"}
          </Line>
        </Card>
      </div>
    </div>
  );
}

function Card({ title, warn, children }: { title: string; warn?: boolean; children: ReactNode }) {
  const id = `health-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <section className={h.card} aria-labelledby={id} data-warn={warn || undefined}>
      <h3 id={id} className={h.cardTitle}>
        {title}
      </h3>
      <div className={h.cardBody}>{children}</div>
    </section>
  );
}
function Figure({ n, label, warn }: { n: number; label: string; warn?: boolean }) {
  return (
    <div className={h.figure} data-warn={warn || undefined}>
      <span className={h.n}>{n}</span>
      <span className={h.nLabel}>{label}</span>
    </div>
  );
}
function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className={h.line}>
      <span>{label}</span> <b>{children}</b>
    </p>
  );
}
