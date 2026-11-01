"use client";
import { firstNameOf } from "@lume/core/shared";
import { AnimatePresence } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AiGlyph } from "@/components/ai/AiGlyph";
import { useToast } from "@/components/feedback/ToastProvider";
import { Button } from "@/components/ui/Button";
import { aiClient } from "@/lib/ai/client";
import { autopilotClient, type LeadStanding } from "@/lib/autopilot/client";
import { useAutopilot } from "@/lib/notifications/stream";
import { StartSheet } from "./StartSheet";
import s from "./hand.module.css";

const WORKING = new Set(["up_next", "writing", "sent", "replied", "talking"]);

/**
 * "Let LUME AI handle this" wherever a lead is (owner, 2026-11-01): one press, and LUME AI has the lead. Not in a run: the
 * start sheet for this one lead, with the business's own choices. Ready for a person or waiting on one: Let LUME AI carry
 * on (its run's controllers). Taken over: hand it back. Already working it: says so, a link to watch. Nothing at all
 * while LUME AI is off or for someone who can't start it.
 */
export function HandToAi({
  leadId,
  leadName,
  canStart,
  size = "sm",
}: {
  leadId: string;
  leadName: string;
  /** May start LUME AI runs (messages.send_queue). */
  canStart: boolean;
  size?: "sm" | "md";
}) {
  const { toast } = useToast();
  const [on, setOn] = useState(false);
  const [standing, setStanding] = useState<LeadStanding | null>(null);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const who = firstNameOf(leadName) || leadName;

  const read = useCallback(() => {
    void Promise.all([aiClient.status(), autopilotClient.leadState(leadId)]).then(([st, l]) => {
      setOn(st.ok && st.data.on);
      if (l.ok) setStanding(l.data);
    });
  }, [leadId]);
  useEffect(() => {
    setStanding(null);
    read();
  }, [read]);
  // Its run moved on (a reply, ready, a take-over): where it stands now.
  useAutopilot((e) => {
    if (e.lead === leadId || e.run === "*") read();
  });

  const step = async (f: () => Promise<{ ok: boolean; message?: string }>, done: string) => {
    if (busy) return;
    setBusy(true);
    const r = await f();
    setBusy(false);
    if (!r.ok) return toast({ tone: "warn", title: "LUME AI couldn't take it", detail: r.message ?? "" });
    toast({ tone: "accent", title: done });
    read();
  };

  if (!on || !standing) return null;
  const glyph = <AiGlyph size={size === "sm" ? 14 : 16} />;
  // An ended run lets its leads go (the server says none): only a lead in no run is started here.
  if (!standing.run) {
    if (!canStart) return null;
    return (
      <>
        <Button
          size={size}
          className={s.go}
          onClick={() => setStarting(true)}
          aria-label={`Let LUME AI handle ${who}`}
        >
          {glyph}
          Let LUME AI handle this
        </Button>
        <AnimatePresence>
          {starting && (
            <StartSheet
              target={{ leadIds: [leadId] }}
              count={1}
              onClose={() => setStarting(false)}
              onStarted={() => {
                setStarting(false);
                toast({ tone: "accent", title: `LUME AI has ${who} now` });
                read();
              }}
            />
          )}
        </AnimatePresence>
      </>
    );
  }
  const run = standing.run;
  if (standing.state === "ready" || standing.state === "needs_you")
    return standing.canDecide ? (
      <Button
        size={size}
        className={s.go}
        disabled={busy}
        onClick={() =>
          void step(() => autopilotClient.carryOn(run.id, leadId), `LUME AI is back with ${who}`)
        }
      >
        {glyph}
        Let LUME AI carry on
      </Button>
    ) : null;
  if (standing.state === "with_you")
    return (
      <Button
        size={size}
        className={s.go}
        disabled={busy}
        onClick={() =>
          void step(() => autopilotClient.handBack(run.id, leadId), `LUME AI is back with ${who}`)
        }
      >
        {glyph}
        Hand back to LUME AI
      </Button>
    );
  if (WORKING.has(standing.state))
    return (
      <Link href={`/autopilot?run=${encodeURIComponent(run.id)}`} className={s.on}>
        <AiGlyph size={14} draw="loop" />
        LUME AI is on it
      </Link>
    );
  return null;
}
