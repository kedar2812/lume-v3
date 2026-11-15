"use client";
import { useEffect, useRef, useState } from "react";
import { tasksClient } from "@/lib/tasks/client";
import type { TodayView, YourDay } from "@/lib/tasks/types";
import { fromToday, type DayData } from "@/lib/today/day-items";

/** Another day's answer as a day: open follow-ups, done ones, calls. */
export function fromYourDay(y: YourDay): DayData {
  return {
    followUps: y.followUps.filter((f) => f.status === "open"),
    doneFollowUps: y.followUps
      .filter((f) => f.status === "done")
      .map((f) => ({ id: f.id, title: f.title, dueAt: f.dueAt, leadId: f.leadId, leadName: f.leadName })),
    meetings: y.meetings,
  };
}

/**
 * One day's things: today straight from what Today already has (live), another day from /your-day. While another day
 * loads, the last day shown stays (faded) instead of the screen going blank.
 */
export function useDayData(day: string, today: string, v: TodayView) {
  const [cache, setCache] = useState<Record<string, DayData>>({});
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const last = useRef<{ data: DayData; of: string } | null>(null);

  useEffect(() => {
    if (day === today || cache[day]) return;
    let live = true;
    setFailed(null);
    tasksClient
      .day(day)
      .then((r) => {
        if (!live) return;
        if (r.ok) setCache((c) => ({ ...c, [day]: fromYourDay(r.data) }));
        else setFailed(day);
      })
      .catch(() => live && setFailed(day));
    return () => {
      live = false;
    };
    // `cache` is read, not watched: a day already fetched isn't fetched again.
  }, [day, today, attempt]);

  const data = day === today ? fromToday(v) : (cache[day] ?? null);
  if (data) last.current = { data, of: day };
  return {
    state: data ? ("ready" as const) : failed === day ? ("error" as const) : ("loading" as const),
    data: data ?? last.current?.data ?? null,
    /** Which day `data` is: the day asked for, or while it loads, the last one shown. */
    of: data ? day : (last.current?.of ?? day),
    stale: !data,
    retry: () => setAttempt((n) => n + 1),
  };
}
