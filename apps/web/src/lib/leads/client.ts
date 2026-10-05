"use client";
import { api } from "@/lib/api";
import { noteNearLimit } from "@/lib/security/near-limit";
import { apiQuery, type ListFilters } from "./filters";
import type { Activity, BulkAction, BulkResult, Duplicate, Lead, LeadPage } from "./types";

export const PAGE_SIZE = 50;
/** What a Sent or a reply did to the stage (4A): moved (and from where), or why it couldn't. */
export type MoveResult = {
  /** undoable: moving back undoes it (neither stage runs automations a move back would repeat). */
  moved: { stageId: string; stageName: string; fromStageId: string; undoable: boolean } | null;
  notMoved?: { code: string; message: string };
};
const enc = encodeURIComponent;

/** Every lead call the screens make. Each returns ApiResult, so callers handle refusal explicitly. */
export const leadsClient = {
  list: (f: ListFilters, cursor?: string, limit = PAGE_SIZE) =>
    api.get<LeadPage>(`/api/v1/leads?${apiQuery(f)}&limit=${limit}${cursor ? `&cursor=${enc(cursor)}` : ""}`),
  counts: (f: ListFilters & { pipelineId: string }) => {
    const q = new URLSearchParams(apiQuery(f));
    q.delete("sort");
    return api.get<{ counts: Record<string, number>; values: Record<string, number>; total: number }>(
      `/api/v1/leads/counts?${q}`,
    );
  },
  /** A lead, opened. Near a watch limit (6A), it comes with a quiet notice, raised here for the screen. */
  get: async (id: string) => {
    const r = await api.get<{ lead: Lead; watch?: { nearLimit: boolean } }>(`/api/v1/leads/${id}`);
    if (r.ok && r.data.watch?.nearLimit) noteNearLimit();
    return r;
  },
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
  /** A phone call, logged: how it went, what was said; and, if it's the lead's first contact, how soon it came. */
  logCall: (id: string, outcome: "talked" | "no_answer" | "left_message", note?: string) =>
    api.post<{ activity: Activity; firstContact: { minutes: number } | { days: number } | null }>(
      `/api/v1/leads/${id}/calls`,
      {
        outcome,
        ...(note ? { note } : {}),
      },
    ),
  activities: (id: string, cursor?: string) =>
    api.get<{ items: Activity[]; nextCursor: string | null }>(
      `/api/v1/leads/${id}/activities${cursor ? `?cursor=${enc(cursor)}` : ""}`,
    ),
  reveal: async (id: string) => {
    const r = await api.post<{
      phone: string | null;
      email: string | null;
      instagram: string | null;
      nearLimit?: boolean;
    }>(`/api/v1/leads/${id}/contact/reveal`);
    if (r.ok && r.data.nearLimit) noteNearLimit();
    return r;
  },
  bulk: (ids: string[], action: BulkAction) => api.post<BulkResult>("/api/v1/leads/bulk", { ids, action }),
  duplicates: (c: { phone?: string; email?: string }) => {
    const q = new URLSearchParams(Object.entries(c).filter((e): e is [string, string] => !!e[1]));
    return api.get<{ duplicates: Duplicate[] }>(`/api/v1/leads/duplicates?${q}`);
  },
  /** From a template, send its version (the words the person saw); from a follow-up, its id. */
  prepareMessage: (id: string, text: string, from: { templateVersionId?: string; taskId?: string } = {}) =>
    api.post<{ url: string }>(`/api/v1/leads/${id}/messages/prepare`, { text, ...from }),
  confirmMessage: (id: string, sent: boolean, taskId?: string) =>
    api.post<MoveResult>(`/api/v1/leads/${id}/messages/confirm`, { sent, ...(taskId ? { taskId } : {}) }),
  replied: (id: string) => api.post<MoveResult>(`/api/v1/leads/${id}/replied`),
  remove: (id: string) => api.del<null>(`/api/v1/leads/${id}`),
};
