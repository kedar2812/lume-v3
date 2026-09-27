import type { DraftView } from "@/lib/imports/types";

export type IntegrationsView = {
  googleSheets: { enabled: boolean; available: boolean; email: string | null };
};
export type InspectView = {
  spreadsheetId: string;
  title: string;
  gid: number | null;
  tabs: { sheetId: number; title: string }[];
  email: string;
};
export type SheetDraft = {
  draft: DraftView;
  sheet: {
    title: string;
    name: string;
    tabTitle: string;
    email: string;
    moreRows: boolean;
    editing: string | null;
  };
};
export type SheetStatus = "active" | "paused" | "needs_attention";
export type SheetSourceView = {
  id: string;
  name: string;
  status: SheetStatus;
  attention: { code: string; message: string } | null;
  tabTitle: string;
  link: string;
  pollSeconds: number;
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
  syncing: boolean;
  failing: boolean;
  lastError: string | null;
  newColumns: string[];
  newToday: number;
  newAllTime: number;
  problems: number;
  runAs: { id: string; name: string } | null;
};
export type SyncView = {
  id: string;
  trigger: "schedule" | "refresh" | "connect" | "manual";
  status: "queued" | "running" | "done" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  created: number;
  merged: number;
  errors: number;
  error: string | null;
};
export type ProblemRowView = {
  id: number;
  rowNumber: number;
  problems: { code: string; message: string }[];
  lastTriedAt: string;
};
export type SheetSourceDetail = SheetSourceView & { syncs: SyncView[]; problemRows: ProblemRowView[] };
export type SheetsStatus = { refresh: boolean; attention: { id: string; name: string }[] };
export type RefreshProgress = {
  status: "running" | "done";
  rowsRead: number;
  rowsTotal: number;
  created: number;
  merged: number;
  leadIds: string[];
  unreachable: boolean;
  attention: { id: string; name: string }[];
};
export type Arrivals = { since: string | null; count: number; ids: string[] };
/** Attention that "Test again" can clear; the rest need the columns opened and saved. */
export const RETRYABLE = new Set(["ACCESS_LOST", "SHEET_GONE", "TAB_GONE", "TOO_MANY_ROWS", "GOOGLE_SETUP"]);
