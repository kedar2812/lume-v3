"use client";
import { useSyncExternalStore } from "react";
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

/** One file's upload, as the files client answers it. */
export type Send = (
  file: File,
  onProgress: (share: number) => void,
) => Promise<{ ok: true; data: { file: LibraryFile } } | { ok: false; message: string }>;

/** Each file of the batch, kept after its row has left the tray, so the batch's count and bar stay whole. */
type Part = { key: string; size: number; share: number; state: Upload["state"] };
export type UploadsState = {
  /** The tray's rows. */
  uploads: Upload[];
  /** Every file of the batch, from the first given until it's all settled and shown done. */
  batch: Part[];
  /** Files that landed while no Media screen was open to hear them, for the next one that opens. */
  added: LibraryFile[];
};
export type Batch = { total: number; added: number; share: number; done: boolean };

/** Three at a time: thirty photos dropped at once go up steadily instead of all crawling together. */
const AT_ONCE = 3;
/** How long an added file stays in the tray with its tick before it goes. */
const ADDED_MS = 1600;
/** How long a finished batch stays (the sidebar's tick and its three blinks) before it's gone. */
export const DONE_SHOW_MS = 4000;

const settled = (p: Part) => p.state === "added" || p.state === "refused";

/**
 * The whole batch as one: counted by bytes, so a big file half up is most of the way; a refused file is left out, so
 * the bar never waits at 99% for it. Nothing when nothing could go up.
 */
export function batchOf(s: UploadsState): Batch | null {
  const parts = s.batch.filter((p) => p.state !== "refused");
  if (!parts.length) return null;
  const bytes = parts.reduce((n, p) => n + p.size, 0);
  const sent = parts.reduce((n, p) => n + p.size * (p.state === "added" ? 1 : p.share), 0);
  const share = bytes ? sent / bytes : parts.every((p) => p.state === "added") ? 1 : 0;
  return {
    total: parts.length,
    added: parts.filter((p) => p.state === "added").length,
    share: Math.round(share * 1000) / 1000,
    done: s.batch.every(settled),
  };
}

/**
 * Files on their way into Media, kept by LUME rather than by a screen (owner, 2026-10-25): leaving Media doesn't stop
 * them. Three at a time, in the order they were given; a refused one keeps LUME's reason until it's dismissed.
 */
export function createUploads(send: Send) {
  let state: UploadsState = { uploads: [], batch: [], added: [] };
  const listeners = new Set<() => void>();
  const addedListeners = new Set<(f: LibraryFile) => void>();
  const queue: { key: string; file: File }[] = [];
  let running = 0;
  let seq = 0;
  let doneTimer: ReturnType<typeof setTimeout> | null = null;

  const set = (next: UploadsState) => {
    state = next;
    listeners.forEach((l) => l());
  };
  const patch = (key: string, p: Partial<Upload>) =>
    set({
      ...state,
      uploads: state.uploads.map((u) => (u.key === key ? { ...u, ...p } : u)),
      batch: state.batch.map((b) =>
        b.key === key
          ? {
              ...b,
              ...(p.share !== undefined ? { share: p.share } : {}),
              ...(p.state ? { state: p.state } : {}),
            }
          : b,
      ),
    });

  /** Done: shown for a few seconds, then the batch is cleared (the tray's rows go on their own). */
  const settleIfDone = () => {
    if (!state.batch.length || !state.batch.every(settled)) return;
    if (doneTimer) clearTimeout(doneTimer);
    doneTimer = setTimeout(() => {
      doneTimer = null;
      if (state.batch.every(settled)) set({ ...state, batch: [], added: [] });
    }, DONE_SHOW_MS);
  };

  const next = () => {
    while (running < AT_ONCE && queue.length) {
      const { key, file } = queue.shift()!;
      running++;
      patch(key, { state: "uploading" });
      void send(file, (share) => patch(key, { share }))
        .then((r) => {
          if (r.ok) {
            patch(key, { state: "added", share: 1 });
            if (addedListeners.size) addedListeners.forEach((l) => l(r.data.file));
            else set({ ...state, added: [...state.added, r.data.file] });
            setTimeout(
              () => set({ ...state, uploads: state.uploads.filter((u) => u.key !== key) }),
              ADDED_MS,
            );
          } else patch(key, { state: "refused", problem: r.message });
        })
        .catch(() =>
          patch(key, { state: "refused", problem: "LUME couldn't reach the server. Try that file again." }),
        )
        .finally(() => {
          running--;
          next();
          settleIfDone();
        });
    }
  };

  return {
    snapshot: () => state,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    /** A file added, as it lands: a Media screen that's open puts it in its list. */
    onAdded(l: (f: LibraryFile) => void) {
      addedListeners.add(l);
      return () => void addedListeners.delete(l);
    },
    /** What landed while Media was closed, handed over once: a file archived since never comes back. */
    take(): LibraryFile[] {
      const t = state.added;
      if (t.length) set({ ...state, added: [] });
      return t;
    },
    add(files: File[]) {
      if (!files.length) return;
      // A batch that's done (or only refusals) gives way to a new one, counted from nothing.
      const fresh = state.batch.length > 0 && state.batch.every(settled);
      if (fresh && doneTimer) {
        clearTimeout(doneTimer);
        doneTimer = null;
      }
      const given = files.map((file) => ({ key: `u${++seq}`, file }));
      const parts = given.map(({ key, file }) => ({
        key,
        size: file.size,
        share: 0,
        state: "waiting" as const,
      }));
      set({
        uploads: [
          ...state.uploads,
          ...given.map(({ key, file }) => ({
            key,
            name: file.name,
            size: file.size,
            share: 0,
            state: "waiting" as const,
            problem: null,
          })),
        ],
        batch: fresh ? parts : [...state.batch, ...parts],
        added: fresh ? [] : state.added,
      });
      queue.push(...given);
      next();
    },
    dismiss(key: string) {
      set({ ...state, uploads: state.uploads.filter((u) => u.key !== key) });
    },
    /** Something is still going up: closing the tab would lose it. */
    busy: () => state.batch.some((p) => !settled(p)),
  };
}

export type Uploads = ReturnType<typeof createUploads>;

/** LUME's one set of uploads, for every screen. */
export const uploads: Uploads = createUploads((file, onProgress) =>
  filesClient.uploadWithProgress(file, onProgress),
);

export function useUploads(): UploadsState {
  return useSyncExternalStore(uploads.subscribe, uploads.snapshot, uploads.snapshot);
}

/** The batch on its way, or just done; nothing otherwise. */
export function useUploadBatch(): Batch | null {
  return batchOf(useUploads());
}
