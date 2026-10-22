"use client";
import Link from "next/link";
import { useState } from "react";
import { aiClient } from "@/lib/ai/client";
import type { AiLimit, AiStatus } from "@/lib/ai/types";
import { pausedWords } from "@/lib/ai/words";
import s from "./ring.module.css";

const n = (x: number) => x.toLocaleString("en-US");

/**
 * Which limit the ring measures: the month when the licence signs one, else the week (a licence server from before
 * the monthly allowance), else the month's count with no limit.
 */
export function measured(st: AiStatus): { limit: AiLimit; per: "month" | "week" } {
  if (st.month.limit !== null) return { limit: st.month, per: "month" };
  if (st.week.limit !== null) return { limit: st.week, per: "week" };
  return { limit: st.month, per: "month" };
}
export const shareOf = (l: AiLimit) => (l.limit ? Math.min(1, l.used / l.limit) : 0);
/** Amber from 80%, and while the month's allowance is used up. */
export const amberAt = (st: AiStatus) => st.paused?.by === "month" || shareOf(measured(st).limit) >= 0.8;

const dayWords = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "long", day: "numeric" }).format(new Date(iso));

/**
 * What the ring's panel says (Autopilot spec 2026-10-19 §4), also Settings → LUME AI's Usage: the share used, the pace,
 * this month's, this week's and this hour's use, the spend when the owner set the prices, when it resets, and for an
 * admin, Ask for a top-up. A top-up is only offered against a monthly allowance (a licence server from before it
 * can't take the request).
 */
export function AiRingPanel({
  st,
  tz,
  onAsked,
  settingsLink = false,
  onLeave,
}: {
  st: AiStatus;
  tz: string;
  /** The top-up was asked for (or had been already). */
  onAsked: () => void;
  /** A link to Settings → LUME AI, for admins (not on that page itself). */
  settingsLink?: boolean;
  onLeave?: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { limit, per } = measured(st);
  const share = shareOf(limit);
  const pct = Math.round(share * 100);
  const amber = amberAt(st);
  const monthly = st.month.limit !== null;
  const canAsk = !!st.topUp && !st.topUp.asked && monthly && (pct >= 80 || st.paused?.by === "month");
  const paused = st.paused ? pausedWords(st.paused, tz) : null;
  const daysToReset = Math.max(0, (new Date(st.month.resetsAt).getTime() - Date.now()) / 86_400_000);
  const ask = async () => {
    setAsking(true);
    setProblem(null);
    const r = await aiClient.askTopUp();
    setAsking(false);
    if (!r.ok) return setProblem(r.message);
    onAsked();
  };

  return (
    <div className={s.body}>
      <div className={s.head}>
        <img src="/lume-ai-mark.svg" alt="" width={20} height={20} />
        <b>LUME AI this month</b>
      </div>
      {limit.limit !== null && (
        <div className={s.big}>
          <span className={s.pct} data-tone={amber ? "amber" : undefined}>
            {pct}%{per === "week" && <small> of this week</small>}
          </span>
          <span className={s.meter} aria-hidden>
            <span style={{ transform: `scaleX(${share})` }} data-tone={amber ? "amber" : undefined} />
          </span>
        </div>
      )}
      {paused && <p className={s.paused}>{paused}</p>}
      {!paused && st.pace.daysLeft !== null && (
        <p className={s.line}>
          {st.pace.daysLeft >= daysToReset
            ? "Enough for the month at this pace"
            : `About ${n(st.pace.daysLeft)} ${st.pace.daysLeft === 1 ? "day" : "days"} left at this pace`}
        </p>
      )}
      <dl className={s.rows}>
        <div>
          <dt>This month</dt>
          <dd>
            {monthly
              ? `${n(st.month.used)} of ${n(st.month.limit!)} this month`
              : `${n(st.month.used)} this month`}
          </dd>
        </div>
        {!monthly && st.week.limit !== null && (
          <div>
            <dt>This week</dt>
            <dd>
              {n(st.week.used)} of {n(st.week.limit)} this week
            </dd>
          </div>
        )}
        {st.hour.limit !== null && (
          <div>
            <dt>This hour</dt>
            <dd>
              {n(st.hour.used)} of {n(st.hour.limit)} this hour
            </dd>
          </div>
        )}
        {st.spend && (
          <div>
            <dt>Spend</dt>
            <dd>
              ${st.spend.used.toFixed(2)}
              {st.spend.cap !== null ? ` of $${n(st.spend.cap)}` : ""} this month
            </dd>
          </div>
        )}
        <div>
          <dt>Resets</dt>
          <dd>Resets on {dayWords(st.month.resetsAt, tz)}</dd>
        </div>
      </dl>
      {canAsk && (
        <button type="button" className={s.ask} disabled={asking} onClick={() => void ask()}>
          {asking ? "Asking…" : "Ask for a top-up"}
        </button>
      )}
      {st.topUp?.asked && <p className={s.asked}>Asked. LUME will let you know when it&apos;s added.</p>}
      {problem && (
        <p role="alert" className={s.problem}>
          {problem}
        </p>
      )}
      {settingsLink && st.topUp && (
        <Link href="/settings/ai" className={s.link} onClick={onLeave}>
          LUME AI settings
        </Link>
      )}
    </div>
  );
}
