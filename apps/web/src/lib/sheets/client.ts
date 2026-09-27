"use client";
import { api } from "@/lib/api";
import type {
  Arrivals,
  InspectView,
  IntegrationsView,
  RefreshProgress,
  SheetDraft,
  SheetSourceDetail,
  SheetSourceView,
  SheetsStatus,
} from "./types";

const src = (id: string) => `/api/v1/sheets/sources/${encodeURIComponent(id)}`;

export const sheetsClient = {
  integrations: () => api.get<IntegrationsView>("/api/v1/integrations"),
  setEnabled: (enabled: boolean) =>
    api.put<IntegrationsView>("/api/v1/integrations/google-sheets", { enabled }),
  inspect: (link: string) => api.post<InspectView>("/api/v1/sheets/inspect", { link }),
  draft: (b: { link: string; sheetId: number; headerRow?: number } | { sourceId: string }) =>
    api.post<SheetDraft>("/api/v1/sheets/drafts", b),
  save: (b: { importId: string; name: string; pollSeconds: number; startFrom: "all" | "new" }) =>
    api.post<SheetSourceView>("/api/v1/sheets/sources", b),
  list: () => api.get<{ sources: SheetSourceView[] }>("/api/v1/sheets/sources"),
  get: (id: string) => api.get<SheetSourceDetail>(src(id)),
  patch: (id: string, p: { name?: string; pollSeconds?: number; paused?: boolean }) =>
    api.patch<SheetSourceView>(src(id), p),
  remove: (id: string) => api.del<null>(src(id)),
  sync: (id: string) => api.post<{ syncId: string | null }>(`${src(id)}/sync`),
  dismiss: (id: string, rowId: number) => api.post<null>(`${src(id)}/rows/${rowId}/dismiss`),
  problemsUrl: (id: string) => `${src(id)}/problems.csv`,
  status: () => api.get<SheetsStatus>("/api/v1/sheets/status"),
  refresh: () => api.post<{ id: string }>("/api/v1/sheets/refresh"),
  progress: (id: string) => api.get<RefreshProgress>(`/api/v1/sheets/refresh/${encodeURIComponent(id)}`),
  arrivals: () => api.get<Arrivals>("/api/v1/leads/arrivals"),
  seen: () => api.post<null>("/api/v1/leads/arrivals/seen"),
};
