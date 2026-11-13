"use client";
import { tierName, type PlanTier } from "@lume/core/shared";
import { useState } from "react";
import { api } from "@/lib/api";
import s from "./licence.module.css";

/**
 * "Ask about Max" (Plans and pricing, November 2026): one tap sends the request to LUME through the licence server,
 * in words the owner reads; nobody leaves the app. Admins only (the API refuses anyone else).
 */
export function AskAboutPlan({ tier, quiet = false }: { tier: PlanTier; quiet?: boolean }) {
  const [phase, setPhase] = useState<"idle" | "asking" | "asked">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const ask = async () => {
    setPhase("asking");
    setProblem(null);
    const r = await api.post<{ asked: true }>("/api/v1/plan/ask", { tier });
    if (!r.ok) {
      setPhase("idle");
      return setProblem(r.message);
    }
    setPhase("asked");
  };
  if (phase === "asked") return <p className={s.planAsked}>Asked. LUME will let you know.</p>;
  return (
    <div className={s.planAsk}>
      <button
        type="button"
        className={quiet ? s.btnSecondary : s.btnPrimary}
        disabled={phase === "asking"}
        onClick={() => void ask()}
      >
        {phase === "asking" ? "Asking…" : `Ask about ${tierName(tier)}`}
      </button>
      {problem && (
        <p role="alert" className={s.planProblem}>
          {problem}
        </p>
      )}
    </div>
  );
}
