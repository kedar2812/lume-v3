import type { LiveSheetPreset, LiveSheetRule } from "@lume/core/shared";
import { api } from "@/lib/api";

/** Live sheets (spec 2026-11-14): what the page, the form and the buttons read and send. */
export type LiveSheetStatus = "making" | "live" | "updating" | "paused";
export type LiveSheetPause =
  "google_disconnected" | "sheet_gone" | "maker_gone" | "tier" | "licence" | "paused_by_person";
export type LiveSheetView = {
  id: string;
  name: string;
  preset: LiveSheetPreset;
  rule: LiveSheetRule;
  ruleWords: string;
  columns: string[];
  edits: "keep" | "replace";
  status: LiveSheetStatus;
  pauseReason: LiveSheetPause | null;
  /** A passing trouble the last run met ("Google is slow"), cleared by the next good run. */
  lastError: string | null;
  url: string | null;
  leadCount: number;
  capped: boolean;
  lastSyncedAt: string | null;
  run: { total: number; written: number; status: "queued" | "running" | "done" | "failed" } | null;
  madeBy: { id: string; name: string };
  runsAs: { id: string; name: string };
  createdAt: string;
};
export type GoogleAccount = { id: string; email: string };
export type SheetDraft = {
  name: string;
  preset: LiveSheetPreset;
  rule: LiveSheetRule;
  columns: string[];
  edits: "keep" | "replace";
  grantId: string;
};

const one = (id: string) => `/api/v1/live-sheets/${encodeURIComponent(id)}`;

export const liveSheetsClient = {
  list: () =>
    api.get<{ sheets: LiveSheetView[]; setup: { sheetsOn: boolean; connectWithGoogle: boolean } }>(
      "/api/v1/live-sheets",
    ),
  get: (id: string) => api.get<{ sheet: LiveSheetView }>(one(id)),
  count: (preset: LiveSheetPreset, rule: LiveSheetRule) =>
    api.post<{ matching: number; missingContact: number }>("/api/v1/live-sheets/count", { preset, rule }),
  create: (draft: SheetDraft) => api.post<{ sheet: LiveSheetView }>("/api/v1/live-sheets", draft),
  edit: (id: string, patch: Partial<Omit<SheetDraft, "grantId">>) =>
    api.patch<{ sheet: LiveSheetView }>(one(id), patch),
  run: (id: string) => api.post<{ sheet: LiveSheetView }>(`${one(id)}/run`),
  pause: (id: string) => api.post<{ sheet: LiveSheetView }>(`${one(id)}/pause`),
  resume: (id: string) => api.post<{ sheet: LiveSheetView }>(`${one(id)}/resume`),
  takeOver: (id: string) => api.post<{ sheet: LiveSheetView }>(`${one(id)}/take-over`),
  /** The file was deleted in Google: LUME makes a new one with the same settings. */
  remake: (id: string) => api.post<{ sheet: LiveSheetView }>(`${one(id)}/remake`),
  remove: (id: string, trash: boolean) =>
    api.del<{ deleted: true; trashed: boolean; url: string | null }>(`${one(id)}${trash ? "?trash=1" : ""}`),
  grants: () => api.get<{ grants: GoogleAccount[] }>("/api/v1/live-sheets/grants"),
  connectStart: () => api.post<{ url: string }>("/api/v1/live-sheets/connect"),
  connectComplete: (p: string, s: string) =>
    api.post<{ grant: GoogleAccount }>("/api/v1/live-sheets/connect/complete", { p, s }),
};

/** Each pause in words, and the one thing that fixes it (spec §5). */
export const PAUSES: Record<
  LiveSheetPause,
  { words: string; fix: "connect" | "remake" | "take_over" | "plan" | "resume" | null }
> = {
  google_disconnected: {
    words: "LUME can't reach the Google account it writes with. Connect Google again to carry on.",
    fix: "connect",
  },
  sheet_gone: {
    words: "The sheet was deleted in Google, or moved to the bin. Make it again to carry on.",
    fix: "remake",
  },
  maker_gone: {
    words: "The person it runs as can't export leads any more, or has left. An admin can take it over.",
    fix: "take_over",
  },
  tier: {
    words: "Live sheets come with Pro. LUME keeps this one as it is until your plan includes them.",
    fix: "plan",
  },
  licence: { words: "LUME's licence isn't active, so live sheets wait until it is.", fix: null },
  paused_by_person: { words: "Paused. LUME won't change the sheet until it's resumed.", fix: "resume" },
};
