"use client";
import Link from "next/link";
import { nextTier, tierName } from "@lume/core/shared";
import { useState } from "react";
import { useTier } from "@/components/licence/LicenceProvider";
import { aiClient } from "@/lib/ai/client";
import type { AiLimit, AiStatus } from "@/lib/ai/types";
import { pausedWords } from "@/lib/ai/words";
import { AiGlyph } from "./AiGlyph";
import s from "./ring.module.css";

const n = (x: number) => x.toLocaleString("en-US");
/** What an admin asking about a bigger plan sends with the request. */
export const BIGGER_PLAN_NOTE = "They'd like a bigger plan, with more AI leads every month.";

/**
 * What the ring measures: this month's AI leads when the licence counts them (owner's spec 2026-11-12), or when it
 * sets no limit at all; else, from a licence server from before AI leads, the month's reads, or the week's.
 */
export function measured(st: AiStatus): { limit: AiLimit; per: "month" | "week"; leads: boolean } {
  if (st.countsLeads || (st.month.limit === null && st.week.limit === null))
    return { limit: st.leads, per: "month", leads: true };
  if (st.month.limit !== null) return { limit: st.month, per: "month", leads: false };
  return { limit: st.week, per: "week", leads: false };
}
export const shareOf = (l: AiLimit) => (l.limit ? Math.min(1, l.used / l.limit) : 0);
/** Every one of this month's AI leads is used: no new lead can start (Base, 0, is always). */
export const leadsFull = (st: AiStatus) =>
  measured(st).leads && st.leads.limit !== null && st.leads.used >= st.leads.limit;
/** Amber from 80%, and while the month's AI leads are used up or LUME AI is paused for the month. */
export const amberAt = (st: AiStatus) =>
  st.paused?.by === "month" || leadsFull(st) || shareOf(measured(st).limit) >= 0.8;

const dayWords = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "long", day: "numeric" }).format(new Date(iso));

/**
 * What the ring's panel says (Autopilot spec 2026-10-19 §4; AI leads 2026-11-12), also Settings → LUME AI's Usage:
 * "X of Y AI leads used this month", the share and the pace, the spend when the owner set the prices, when it resets,
 * and from 80% (or when they're all used) for an admin, Ask for a top-up or about a bigger plan. The hour and the
 * month's reads are a safety net once AI leads are counted: never shown as numbers, only as a pause if one is reached.
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
  const [asking, setAsking] = useState<"topup" | "plan" | null>(null);
  // On a tier (Plans and pricing, November 2026): the plan to ask about is the next one by name; none above Enterprise.
  const { tier } = useTier();
  const next = tier ? nextTier(tier) : null;
  const planNote = next ? `They'd like to move to ${tierName(next)}.` : BIGGER_PLAN_NOTE;
  const [problem, setProblem] = useState<string | null>(null);
  const { limit, per, leads } = measured(st);
  const share = shareOf(limit);
  const pct = Math.round(share * 100);
  const amber = amberAt(st);
  const full = leadsFull(st);
  const monthly = limit.limit !== null && per === "month";
  const canAsk = !!st.topUp && !st.topUp.asked && monthly && (pct >= 80 || full || st.paused?.by === "month");
  const paused = st.paused ? pausedWords(st.paused, tz) : null;
  const resets = dayWords(st.month.resetsAt, tz);
  const daysToReset = Math.max(0, (new Date(st.month.resetsAt).getTime() - Date.now()) / 86_400_000);
  const ask = async (what: "topup" | "plan") => {
    setAsking(what);
    setProblem(null);
    const r = await aiClient.askTopUp(what === "plan" ? planNote : undefined);
    setAsking(null);
    if (!r.ok) return setProblem(r.message);
    onAsked();
  };

  return (
    <div className={s.body}>
      <div className={s.head}>
        <AiGlyph size={20} />
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
      {leads && (
        <p className={s.line}>
          <b>
            {limit.limit !== null
              ? `${n(limit.used)} of ${n(limit.limit)} AI leads used this month`
              : `${n(limit.used)} AI ${limit.used === 1 ? "lead" : "leads"} this month`}
          </b>
        </p>
      )}
      {paused && <p className={s.paused}>{paused}</p>}
      {!paused && full && (
        <p className={s.paused}>
          {limit.limit === 0
            ? "Your plan has no AI leads, so LUME AI can't start on a lead."
            : `This month's AI leads are used up. Leads LUME AI is already working on carry on; new leads start on ${resets}, or sooner with a top-up.`}
        </p>
      )}
      {!paused && !full && st.pace.daysLeft !== null && (
        <p className={s.line}>
          {st.pace.daysLeft >= daysToReset
            ? "Enough for the month at this pace"
            : `About ${n(st.pace.daysLeft)} ${st.pace.daysLeft === 1 ? "day" : "days"} left at this pace`}
        </p>
      )}
      <dl className={s.rows}>
        {!leads && (
          <div>
            <dt>This month</dt>
            <dd>
              {st.month.limit !== null
                ? `${n(st.month.used)} of ${n(st.month.limit)} this month`
                : `${n(st.month.used)} this month`}
            </dd>
          </div>
        )}
        {!leads && st.month.limit === null && st.week.limit !== null && (
          <div>
            <dt>This week</dt>
            <dd>
              {n(st.week.used)} of {n(st.week.limit)} this week
            </dd>
          </div>
        )}
        {!leads && st.hour.limit !== null && (
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
          <dd>Resets on {resets}</dd>
        </div>
      </dl>
      {canAsk && (
        <div className={s.asks}>
          <button
            type="button"
            className={s.ask}
            disabled={asking !== null}
            onClick={() => void ask("topup")}
          >
            {asking === "topup" ? "Asking…" : leads ? "Ask for a top-up of 100 AI leads" : "Ask for a top-up"}
          </button>
          {leads && (!tier || next) && (
            <button
              type="button"
              className={s.askPlain}
              disabled={asking !== null}
              onClick={() => void ask("plan")}
            >
              {asking === "plan"
                ? "Asking…"
                : next
                  ? `Ask about ${tierName(next)}`
                  : "Ask about a bigger plan"}
            </button>
          )}
        </div>
      )}
      {st.topUp?.asked && <p className={s.asked}>Asked. LUME will let you know when it&apos;s added.</p>}
      {!st.topUp && full && limit.limit !== 0 && (
        <p className={s.line}>An admin can ask for a top-up from here.</p>
      )}
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
