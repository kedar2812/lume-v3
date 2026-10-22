"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useZone } from "@/components/ZoneProvider";
import { Popover } from "@/components/ui/Popover";
import { aiClient } from "@/lib/ai/client";
import type { AiStatus } from "@/lib/ai/types";
import { useStream } from "@/lib/notifications/stream";
import { AiRingPanel, amberAt, measured, shareOf } from "./AiRingPanel";
import s from "./ring.module.css";

/** How often the ring looks again on its own while the tab is shown (also on a notification, and as it opens). */
const REFRESH_MS = 60_000;
const R = 8;
const C = 2 * Math.PI * R;

/** Calls `on` once as it mounts: the panel looking again each time it opens. */
function OnShow({ on, children }: { on: () => void; children: ReactNode }) {
  const once = useRef(on);
  useEffect(() => once.current(), []);
  return children;
}

/**
 * LUME AI's ring (Autopilot spec 2026-10-19 §4): a small ring beside the bell, filling with the month's use and turning
 * amber past 80%, the LUME AI mark inside. Its panel is `AiRingPanel`. Shown only while LUME AI is on for this person.
 */
export function AiRing() {
  const tz = useZone();
  const [st, setSt] = useState<AiStatus | null>(null);

  const load = useCallback(async () => {
    const r = await aiClient.status();
    if (r.ok) setSt(r.data);
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);
  // A limit notice (or anything else the bell hears) is a moment the month may have moved.
  useStream(() => void load());

  if (!st?.on) return null;
  const { limit, per } = measured(st);
  const share = shareOf(limit);
  const name =
    st.paused?.by === "month"
      ? "LUME AI: this month's allowance is used up"
      : limit.limit
        ? `LUME AI: ${Math.round(share * 100)}% of this ${per} used`
        : `LUME AI: ${limit.used.toLocaleString("en-US")} used this month`;

  return (
    <Popover
      label="LUME AI this month"
      triggerLabel={name}
      triggerClassName={s.ring}
      align="end"
      trigger={
        <span className={s.face} data-tone={amberAt(st) ? "amber" : undefined}>
          <svg viewBox="0 0 20 20" aria-hidden>
            <circle cx="10" cy="10" r={R} className={s.track} />
            <circle
              cx="10"
              cy="10"
              r={R}
              className={s.fill}
              strokeDasharray={C}
              strokeDashoffset={C * (1 - share)}
              transform="rotate(-90 10 10)"
            />
          </svg>
          <img src="/lume-ai-mark.svg" alt="" className={s.mark} />
        </span>
      }
    >
      {(close) => (
        <OnShow on={() => void load()}>
          <AiRingPanel
            st={st}
            tz={tz}
            settingsLink
            onLeave={close}
            onAsked={() => setSt((x) => (x ? { ...x, topUp: { asked: true } } : x))}
          />
        </OnShow>
      )}
    </Popover>
  );
}
