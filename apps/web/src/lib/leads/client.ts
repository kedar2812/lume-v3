"use client";
import { api } from "@/lib/api";
import { apiQuery, type ListFilters } from "./filters";
import type { Activity, BulkAction, BulkResult, Duplicate, Lead, LeadPage } from "./types";

export const PAGE_SIZE = 50;
const enc = encodeURIComponent;

/** Every lead call the screens make. Each returns ApiResult, so callers handle refusal explicitly. */
export const leadsClient = {
  list: (f: ListFilters, cursor?: string, limit = PAGE_SIZE) =>
    api.get<LeadPage>(`/api/v1/leads?${apiQuery(f)}&limit=${limit}${cursor ? `&cursor=${enc(cursor)}` : ""}`),
  counts: (f: ListFilters & { pipelineId: string }) => {
    const q = new URLSearchParams(apiQuery(f));
    q.delete("sort");
    return api.get<{ counts: Record<string, number>; total: number }>(`/api/v1/leads/counts?${q}`);
  },
  get: (id: string) => api.get<{ lead: Lead }>(`/api/v1/leads/${id}`),
  create: (input: Record<string, unknown>) =>
    api.post<{ lead: Lead; duplicates: Duplicate[] }>("/api/v1/leads", input),
  patch: (id: string, version: number, patch: Record<string, unknown>) =>
    api.patchIf<{ lead: Lead }>(`/api/v1/leads/${id}`, version, patch),
  move: (id: string, stageId: string, extra: { lostReasonId?: string; lostNote?: string } = {}) =>
    api.post<{ lead: Lead }>(`/api/v1/leads/${id}/stage`, { stageId, ...extra }),
  assign: (id: string, ownerId: string | null) =>
    api.post<{ id: string; ownerId: string | null; visible: boolean }>(`/api/v1/leads/${id}/assign`, {
      ownerId,
    }),
  note: (id: string, body: string) => api.post<{ activity: Activity }>(`/api/v1/leads/${id}/notes`, { body }),
  activities: (id: string, cursor?: string) =>
    api.get<{ items: Activity[]; nextCursor: string | null }>(
      `/api/v1/leads/${id}/activities${cursor ? `?cursor=${enc(cursor)}` : ""}`,
    ),
  reveal: (id: string) =>
    api.post<{ phone: string | null; email: string | null; instagram: string | null }>(
      `/api/v1/leads/${id}/contact/reveal`,
    ),
  bulk: (ids: string[], action: BulkAction) => api.post<BulkResult>("/api/v1/leads/bulk", { ids, action }),
  duplicates: (c: { phone?: string; email?: string }) => {
    const q = new URLSearchParams(Object.entries(c).filter((e): e is [string, string] => !!e[1]));
    return api.get<{ duplicates: Duplicate[] }>(`/api/v1/leads/duplicates?${q}`);
  },
  prepareMessage: (id: string, text: string) =>
    api.post<{ url: string }>(`/api/v1/leads/${id}/messages/prepare`, { text }),
  confirmMessage: (id: string, sent: boolean) =>
    api.post<null>(`/api/v1/leads/${id}/messages/confirm`, { sent }),
  remove: (id: string) => api.del<null>(`/api/v1/leads/${id}`),
};
