"use client";
import { nextTier, PLAN_TIERS, TIER_LINES, tierName, type PlanTier } from "@lume/core/shared";
import { AskAboutPlan } from "./AskAboutPlan";
import { useLicence } from "./LicenceProvider";
import s from "./licence.module.css";

const LEADS = /AI leads a month/;
/** Everything up to this tier, in order, with only its own AI leads a month (never two numbers). */
function linesUpTo(tier: PlanTier): string[] {
  const all = PLAN_TIERS.slice(0, PLAN_TIERS.indexOf(tier) + 1).flatMap((t) => TIER_LINES[t]);
  const last = all.findLastIndex((l) => LEADS.test(l));
  // Pro's own line ("LUME AI, with 1,000 AI leads a month") gives way to a higher tier's number.
  return all.filter((l, i) => !LEADS.test(l) || i === last);
}

const Tick = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <path
      d="M3.5 8.5l3 3 6-7"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const Plus = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
  </svg>
);

/**
 * Settings → About, Your plan (Plans and pricing, November 2026): the tier, what's in it, and what the next tier adds,
 * with Ask about it for admins. Where a locked feature links ("Upgrade to Max"), it lands here (#plan). No tier: no card.
 */
export function PlanCard() {
  const { licence, canManage: admin } = useLicence();
  const tier = licence.tier ?? null;
  if (!tier) return null;
  const next = nextTier(tier);
  return (
    <section id="plan" aria-label="Your plan" className={`${s.aboutCard} ${s.planCard}`}>
      <div className={s.planHead}>
        <h3 className={s.aboutCardTitle}>Your plan</h3>
        <span className={s.planPill}>{tierName(tier)}</span>
      </div>
      <div className={s.planCols} data-single={!next || undefined}>
        <div>
          <p className={s.planSub} id="plan-in">
            In your plan
          </p>
          <ul aria-labelledby="plan-in" className={s.planList}>
            {linesUpTo(tier).map((l) => (
              <li key={l}>
                <Tick />
                {l}
              </li>
            ))}
          </ul>
        </div>
        {next ? (
          <div className={s.planNext}>
            <p className={s.planSub} id="plan-next">
              {tierName(next)} adds
            </p>
            <ul aria-labelledby="plan-next" className={s.planList} data-next>
              {TIER_LINES[next].map((l) => (
                <li key={l}>
                  <Plus />
                  {l}
                </li>
              ))}
            </ul>
            {admin ? (
              <AskAboutPlan tier={next} />
            ) : (
              <p className={s.aboutWords}>An admin can ask LUME about {tierName(next)}.</p>
            )}
          </div>
        ) : (
          <p className={s.aboutWords}>Everything LUME offers is in your plan.</p>
        )}
      </div>
    </section>
  );
}
