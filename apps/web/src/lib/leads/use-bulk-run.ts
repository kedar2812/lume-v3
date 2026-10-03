"use client";
import { useEffect, useState } from "react";
import { bulkRunsClient, isLive, type RunView } from "./bulk-runs";

/** Read a run back every second while it's queued or running; stop once it finishes, or the screen closes. */
export function useBulkRun(initial: RunView | null): RunView | null {
  const [run, setRun] = useState<RunView | null>(initial);
  const id = run?.id;
  const live = isLive(run);
  // A new run (or its undo) starts the reading afresh; the same run passed again changes nothing.
  const key = initial ? `${initial.id}:${initial.status}` : null;
  useEffect(() => {
    setRun(initial);
  }, [key]);
  useEffect(() => {
    if (!id || !live) return;
    let stop = false;
    const t = setInterval(async () => {
      const r = await bulkRunsClient.get(id);
      if (stop || !r.ok) return;
      setRun(r.data.run);
    }, 1000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [id, live]);
  return run;
}
