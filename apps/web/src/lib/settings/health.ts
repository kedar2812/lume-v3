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
  problems: { key: string; words: string }[];
};

export const healthClient = { get: () => api.get<Health>("/api/v1/system/health") };
