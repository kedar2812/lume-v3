"use client";
import type { CleanKind } from "@lume/core/shared";
import { api } from "@/lib/api";

/** Settings › Storage (plan 2026-11-23-storage-clean-up): what the API measures; sizes in bytes. */
export type StorageKind = "whatsapp" | "instagram" | "previews" | "library" | "chat" | "database";
export type Cleanup = {
  id: string;
  kinds: CleanKind[];
  status: "running" | "done" | "failed";
  filesPlanned: number;
  bytesPlanned: number;
  filesDone: number;
  bytesDone: number;
  startedAt: string;
  finishedAt: string | null;
  /** Why it stopped, or what's still to come, in words. */
  problem: string | null;
};
export type Storage = {
  disk: { total: number; free: number } | null;
  kinds: { key: StorageKind; bytes: number; files: number }[];
  other: number | null;
  candidates: { kind: CleanKind; bytes: number; files: number }[];
  measuredAt: string;
  settings: { keepFilesMonths: 3 | 6 | 12 | 24 | null; warnAtPct: 70 | 80 | 90 };
  running: Cleanup | null;
};

export const storageClient = {
  get: (closedMonths?: number) =>
    api.get<Storage>(`/api/v1/storage${closedMonths ? `?closedMonths=${closedMonths}` : ""}`),
  clean: (kinds: CleanKind[], closedMonths?: number) =>
    api.post<Cleanup>("/api/v1/storage/clean-up", { kinds, ...(closedMonths ? { closedMonths } : {}) }),
  progress: (id: string) => api.get<Cleanup>(`/api/v1/storage/clean-up/${encodeURIComponent(id)}`),
  settings: (patch: Partial<Storage["settings"]>) =>
    api.put<{ settings: Storage["settings"] }>("/api/v1/storage/settings", patch),
};
/** The list of what Clean up would clear, as a download from this LUME. */
export const filesCsvUrl = (kinds: CleanKind[], closedMonths?: number) =>
  `/api/v1/storage/clean-up/files.csv?kinds=${kinds.join(",")}${closedMonths ? `&closedMonths=${closedMonths}` : ""}`;
