"use client";
import { useEffect, useId, useRef, useState } from "react";
import { AiGlyph } from "@/components/ai/AiGlyph";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { aiClient } from "@/lib/ai/client";
import type { AiPause } from "@/lib/ai/types";
import { pausedWords } from "@/lib/ai/words";
import s from "./ai.module.css";

type State =
  | { is: "offered" }
  | { is: "reading" }
  | { is: "ready"; lines: [string, string, string] }
  | { is: "limit"; pause: AiPause }
  | { is: "failed" }
  | { is: "gone" };

/**
 * Catch me up (spec 2026-10-18 §5.3; the approved canvas board CatchUp): offered on a lead someone just picked up or
 * one gone quiet, and read only when they ask — three lines from the lead's own notes and calls.
 */
export function CatchUp({ leadId, tz }: { leadId: string; tz: string }) {
  const [state, setState] = useState<State>({ is: "offered" });
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  useEffect(() => {
    if (state.is === "ready") heading.current?.focus();
  }, [state.is]);

  if (state.is === "gone") return null;

  const ask = async () => {
    setState({ is: "reading" });
    const r = await aiClient.catchUp(leadId);
    if (!live.current) return;
    if (!r.ok) return setState({ is: "failed" });
    const d = r.data;
    if (!("unavailable" in d)) return setState({ is: "ready", lines: d.read.lines });
    if (d.unavailable === "limit") return setState({ is: "limit", pause: { by: d.by, until: d.until } });
    setState(d.unavailable === "failed" ? { is: "failed" } : { is: "gone" });
  };

  return (
    <div aria-live="polite" className={s.live}>
      {state.is === "offered" && (
        <div className={s.offer}>
          <p className={s.offerText}>New to this lead? LUME AI can sum up its history in three lines.</p>
          <Button onClick={() => void ask()}>
            <AiGlyph size={16} />
            Catch me up
          </Button>
        </div>
      )}

      {state.is === "reading" && (
        <section aria-busy="true" aria-label="Catch-up" className={s.card}>
          <p className={s.title}>Catching you up…</p>
          <Skeleton width="90%" height={12} radius={6} />
          <Skeleton width="76%" height={12} radius={6} />
          <Skeleton width="84%" height={12} radius={6} />
        </section>
      )}

      {state.is === "ready" && (
        <section aria-labelledby={titleId} className={s.card}>
          <h3 id={titleId} ref={heading} tabIndex={-1} className={s.title}>
            <AiGlyph size={16} />
            Catch-up
          </h3>
          <ol className={s.lines}>
            {state.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ol>
          <div className={s.footSplit}>
            <span className={s.fromStart}>{"From this lead's notes and calls"}</span>
            <Button size="sm" variant="ghost" onClick={() => setState({ is: "gone" })}>
              Close
            </Button>
          </div>
        </section>
      )}

      {state.is === "limit" && (
        <p role="status" className={s.note}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          {pausedWords(state.pause, tz)}
        </p>
      )}

      {state.is === "failed" && (
        <div role="status" className={s.note}>
          <span className={s.noteText}>{"LUME couldn't catch you up just now."}</span>
          <Button onClick={() => void ask()}>Try again</Button>
        </div>
      )}
    </div>
  );
}
