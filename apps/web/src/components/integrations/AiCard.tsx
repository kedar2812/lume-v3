"use client";
import { useEffect, useState } from "react";
import { AiGlyph } from "@/components/ai/AiGlyph";
import { usePlan } from "@/components/licence/LicenceProvider";
import { Switch } from "@/components/ui/Switch";
import { aiClient } from "@/lib/ai/client";
import type { AiLimit, AiStatus } from "@/lib/ai/types";
import { pausedWords, resetWords } from "@/lib/ai/words";
import type { IntegrationsView } from "@/lib/sheets/types";
import { NOT_IN_PLAN_NOTE, NotInPlanPill, inPlan } from "./NotInPlan";
import s from "./integrations.module.css";

type AiView = NonNullable<IntegrationsView["ai"]>;

/** One limit as a line of words and a bar; words alone when there's no limit (spec 2026-10-18 §2.2). */
function Meter({ label, per, l, tz }: { label: string; per: string; l: AiLimit; tz: string }) {
  if (l.limit === null)
    return (
      <div className={s.meter}>
        <div className={s.meterHead}>
          <span className={s.meterLabel}>{label}</span>
          <span>{l.used} · no limit</span>
        </div>
      </div>
    );
  const share = Math.min(1, l.used / l.limit);
  return (
    <div className={s.meter}>
      <div className={s.meterHead}>
        <span className={s.meterLabel}>{label}</span>
        <span>
          {l.used} of {l.limit} · resets {resetWords(l.resetsAt, tz)}
        </span>
      </div>
      <div role="img" aria-label={`${l.used} of ${l.limit} reads ${per}`} className={s.meterTrack}>
        <div
          className={s.meterFill}
          data-high={share >= 0.75 || undefined}
          style={{ width: `${share * 100}%` }}
        />
      </div>
    </div>
  );
}

/** Settings → Integrations → LUME AI (spec 2026-10-18 §2.2): the switch, what's sent where, and this hour's and week's use. */
export function AiCard({ ai, tz, onView }: { ai: AiView; tz: string; onView(v: IntegrationsView): void }) {
  const out = !inPlan(usePlan(), "ai") || !ai.inPlan;
  const usable = ai.available && !out;
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const on = ai.enabled && usable;

  useEffect(() => {
    if (!on) return setStatus(null);
    void aiClient.status().then((r) => r.ok && setStatus(r.data));
  }, [on]);

  const toggle = async (enabled: boolean) => {
    setError(null);
    const r = await aiClient.setEnabled(enabled);
    if (!r.ok) return setError(r.message);
    onView(r.data);
  };

  return (
    <article className={s.card} aria-labelledby="ai-title">
      <header className={s.cardHead}>
        <span className={s.aiTile} aria-hidden>
          <AiGlyph size={20} />
        </span>
        <div className={s.cardText}>
          <h2 id="ai-title" className={s.cardTitle}>
            LUME AI
            {out && <NotInPlanPill />}
          </h2>
          <p className={s.cardLede}>
            {out
              ? NOT_IN_PLAN_NOTE
              : !ai.available
                ? "LUME AI isn't set up on this server yet."
                : "Reads a note after a call and suggests the next step. A person always decides."}
          </p>
        </div>
        <Switch
          checked={on}
          onChange={(v) => void toggle(v)}
          label={
            out ? "LUME AI, not in this LUME’s plan" : !ai.available ? "LUME AI, not set up here" : "LUME AI"
          }
          labelHidden
          disabled={!usable}
        />
      </header>
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      {usable && (
        <p className={s.aiPrivacy}>
          The words of a note are sent to the AI provider to be read. They aren't used to train it, and
          nothing is ever sent to a lead.
        </p>
      )}
      {on && status && (
        <div className={s.meters}>
          {status.paused && (
            <p role="status" className={s.aiPaused}>
              {pausedWords(status.paused, tz)} Notes and calls still save as usual.
            </p>
          )}
          <Meter label="This hour" per="this hour" l={status.hour} tz={tz} />
          <Meter label="This week" per="this week" l={status.week} tz={tz} />
        </div>
      )}
    </article>
  );
}
