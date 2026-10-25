"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAutopilot, type AutopilotEvent } from "@/lib/notifications/stream";
import { autopilotClient } from "./client";
import type { RunDetail } from "./types";

/**
 * One run, kept current (Autopilot A3; spec 2026-10-19 §2.2: the live view is a window onto the server's run). Read
 * once, then again whenever the tab's stream says this run changed, when the stream comes back after a drop, and when
 * the tab is shown again. A burst of changes while a read is out asks once more, not once each; an answer for a run
 * the screen has left never shows. A failed read keeps what's shown and says why.
 */
export function useRun(id: string | null): {
  data: RunDetail | null;
  loading: boolean;
  problem: string | null;
  refresh(): void;
} {
  const [data, setData] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(!!id);
  const [problem, setProblem] = useState<string | null>(null);
  const current = useRef(id);
  /** Each run shown gets its own generation: reads for one the screen has left are ignored, never waited for. */
  const gen = useRef(0);
  const out = useRef(false);
  const again = useRef(false);

  const read = useCallback(() => {
    const want = current.current;
    if (!want) return;
    if (out.current) {
      again.current = true;
      return;
    }
    out.current = true;
    const mine = gen.current;
    void autopilotClient.run(want).then((r) => {
      if (gen.current !== mine) return;
      out.current = false;
      setLoading(false);
      if (r.ok) {
        setData(r.data);
        setProblem(null);
      } else setProblem(r.message);
      if (again.current) {
        again.current = false;
        read();
      }
    });
  }, []);

  useEffect(() => {
    current.current = id;
    gen.current++;
    out.current = false;
    again.current = false;
    setData(null);
    setProblem(null);
    setLoading(!!id);
    if (id) read();
  }, [id, read]);

  useAutopilot((e: AutopilotEvent) => {
    if (e.run === "*" || e.run === current.current) read();
  });

  useEffect(() => {
    const shown = () => {
      if (document.visibilityState === "visible") read();
    };
    document.addEventListener("visibilitychange", shown);
    return () => document.removeEventListener("visibilitychange", shown);
  }, [read]);

  return { data, loading, problem, refresh: read };
}

/**
 * How many LUME AI runs are going that this person can see (the Autopilot nav's Live pill), read again when any run
 * changes. `enabled` false (no access, or LUME AI off) asks nothing.
 */
export function useLiveRuns(enabled: boolean): number {
  const [running, setRunning] = useState(0);
  const out = useRef(false);
  const again = useRef(false);
  const read = useCallback(() => {
    if (out.current) {
      again.current = true;
      return;
    }
    out.current = true;
    void autopilotClient.runs().then((r) => {
      out.current = false;
      if (r.ok) setRunning(r.data.running);
      if (again.current) {
        again.current = false;
        read();
      }
    });
  }, []);
  useEffect(() => {
    if (enabled) read();
  }, [enabled, read]);
  // Only a run's own changes (started, paused, resumed, ended: no lead) move the count; a lead's don't.
  useAutopilot((e) => {
    if (enabled && e.lead === null) read();
  });
  return enabled ? running : 0;
}
