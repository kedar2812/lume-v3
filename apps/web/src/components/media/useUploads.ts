"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { filesClient, type LibraryFile } from "@/lib/files/client";

export type Upload = {
  key: string;
  name: string;
  size: number;
  /** How much has gone up, 0 to 1. */
  share: number;
  state: "waiting" | "uploading" | "added" | "refused";
  problem: string | null;
};

/** Three at a time: thirty photos dropped at once go up steadily instead of all crawling together. */
const AT_ONCE = 3;
/** How long an added file stays in the tray with its tick before it goes. */
const ADDED_MS = 1600;

/**
 * Files on their way into Media: each with its own progress, three at a time, in the order they were given. A refused
 * one keeps LUME's reason until it's dismissed; the others carry on.
 */
export function useUploads(onAdded: (f: LibraryFile) => void) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const queue = useRef<{ key: string; file: File }[]>([]);
  const running = useRef(0);
  const seq = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const added = useRef(onAdded);
  added.current = onAdded;

  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);

  const patch = useCallback(
    (key: string, p: Partial<Upload>) =>
      setUploads((us) => us.map((u) => (u.key === key ? { ...u, ...p } : u))),
    [],
  );

  const next = useCallback(() => {
    while (running.current < AT_ONCE && queue.current.length) {
      const { key, file } = queue.current.shift()!;
      running.current++;
      patch(key, { state: "uploading" });
      void filesClient
        .uploadWithProgress(file, (share) => patch(key, { share }))
        .then((r) => {
          if (r.ok) {
            patch(key, { state: "added", share: 1 });
            added.current(r.data.file);
            const t = setTimeout(() => {
              timers.current.delete(t);
              setUploads((us) => us.filter((u) => u.key !== key));
            }, ADDED_MS);
            timers.current.add(t);
          } else patch(key, { state: "refused", problem: r.message });
        })
        .finally(() => {
          running.current--;
          next();
        });
    }
  }, [patch]);

  const add = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      const fresh = files.map((file) => ({ key: `u${++seq.current}`, file }));
      setUploads((us) => [
        ...us,
        ...fresh.map(({ key, file }) => ({
          key,
          name: file.name,
          size: file.size,
          share: 0,
          state: "waiting" as const,
          problem: null,
        })),
      ]);
      queue.current.push(...fresh);
      next();
    },
    [next],
  );

  const dismiss = useCallback((key: string) => setUploads((us) => us.filter((u) => u.key !== key)), []);

  return { uploads, add, dismiss };
}
