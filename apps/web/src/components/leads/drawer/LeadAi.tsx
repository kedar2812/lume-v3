"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { aiClient } from "@/lib/ai/client";
import type { Catalog } from "@/lib/leads/types";
import { CatchUp } from "./CatchUp";
import { NextStepCard, type NextStepSource } from "./NextStepCard";
import s from "./ai.module.css";

/**
 * LUME AI on one lead (spec 2026-10-18 §5.2–5.3): whether it's on, a next step still waiting, a catch-up to offer,
 * and `suggest` to read a note or a call into a next step. When LUME AI is off, none of it shows.
 */
export function useLeadAi(
  leadId: string,
  o: { tz: string; catalog: Catalog; canEdit: boolean; onApplied(): void },
) {
  const [on, setOn] = useState(false);
  const [offer, setOffer] = useState(false);
  const [card, setCard] = useState<{ key: string; source: NextStepSource } | null>(null);
  const asks = useRef(0);

  // Asked again for each lead (J/K); an answer for a lead no longer shown is dropped.
  useEffect(() => {
    let live = true;
    setOn(false);
    setOffer(false);
    setCard(null);
    void Promise.all([aiClient.status(), aiClient.lead(leadId)]).then(([st, l]) => {
      if (!live || !st.ok || !st.data.on) return;
      setOn(true);
      if (!l.ok) return;
      setOffer(l.data.offerCatchUp);
      if (l.data.pending) setCard({ key: l.data.pending.id, source: { pending: l.data.pending } });
    });
    return () => {
      live = false;
    };
  }, [leadId]);

  /** Read this note or logged call into a next step; it takes the place of any card already showing. */
  const suggest = useCallback(
    (activityId: string, kind: "call" | "note", at: string = new Date().toISOString()) =>
      setCard({ key: `${activityId}:${++asks.current}`, source: { activityId, kind, at } }),
    [],
  );

  const ui =
    on && (card || offer) ? (
      <div className={s.zone}>
        {card && (
          <NextStepCard
            key={card.key}
            leadId={leadId}
            tz={o.tz}
            catalog={o.catalog}
            source={card.source}
            onApplied={o.onApplied}
            onClose={() => setCard(null)}
          />
        )}
        {offer && <CatchUp key={leadId} leadId={leadId} tz={o.tz} />}
      </div>
    ) : null;

  return { canSuggest: on && o.canEdit, suggest, ui };
}
