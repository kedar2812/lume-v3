"use client";
import { api } from "@/lib/api";

/** Settings → System health (3C): what the API reports; counts, times and source names only. */
export type Health = {
  checkedAt: string;
  followUps: { lastSweepAt: string | null; pending: number; late: number; firedToday: number };
  queue: { waiting: number; active: number; retrying: number; failed24h: number };
  digest: { lastSentAt: string | null; sentToday: number; failures24h: number };
  noTouch: { enabled: boolean; lastRunAt: string | null; createdToday: number };
  sources: { id: string; name: string; type: string; status: string; lastSyncAt: string | null }[];
  restoreTest: { at: string | null; ok: boolean | null };
  /** The server's disk and what LUME keeps on it, in bytes (2026-10-19); null where it can't be read. */
  storage: {
    diskTotal: number | null;
    diskFree: number | null;
    database: number | null;
    whatsappFiles: number;
  };
  /** What's wrong, in words, and what to do: a place in LUME to fix it, or "tell" (Tell LUME, a server-side problem). */
  problems: { key: string; words: string; actions: ({ label: string; href: string } | "tell")[] }[];
};

export const healthClient = { get: () => api.get<Health>("/api/v1/system/health") };
