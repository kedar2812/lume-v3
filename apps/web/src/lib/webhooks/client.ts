"use client";
import { api } from "@/lib/api";
import type { DraftView } from "@/lib/imports/types";
import type { IntegrationsView } from "@/lib/sheets/types";
import type { TestPost, WebhookCreated, WebhookDetail, WebhookPreset, WebhookView } from "./types";

const src = (id: string) => `/api/v1/webhooks/sources/${encodeURIComponent(id)}`;

export const webhooksClient = {
  setEnabled: (enabled: boolean) => api.put<IntegrationsView>("/api/v1/integrations/webhooks", { enabled }),
  create: (b: { preset: WebhookPreset; name: string }) =>
    api.post<WebhookCreated>("/api/v1/webhooks/sources", b),
  list: () => api.get<{ sources: WebhookView[] }>("/api/v1/webhooks/sources"),
  get: (id: string) => api.get<WebhookDetail>(src(id)),
  /** The newest test post's paths, or null (204) while none has come in. */
  test: (id: string) => api.get<TestPost | null>(`${src(id)}/test`),
  draft: (id: string) => api.post<DraftView>(`${src(id)}/draft`),
  save: (id: string, b: { importId: string; keepTest: boolean }) =>
    api.post<WebhookView>(`${src(id)}/save`, b),
  patch: (id: string, p: { name?: string; paused?: boolean }) => api.patch<WebhookView>(src(id), p),
  rotate: (id: string) => api.post<{ secret: string }>(`${src(id)}/rotate`),
  retry: (id: string, eventId: number) => api.post<{ queued: true }>(`${src(id)}/events/${eventId}/retry`),
  dismiss: (id: string, eventId: number) => api.post<null>(`${src(id)}/events/${eventId}/dismiss`),
  remove: (id: string) => api.del<null>(src(id)),
};
