"use client";
import type { RenderContext, TemplateCategory } from "@lume/core/shared";
import { api } from "@/lib/api";

/** A template as the API shows it (Phase 4A): its current words, which version they are, who may use it. */
export type TemplateView = {
  id: string;
  name: string;
  category: TemplateCategory;
  allowedRoleIds: string[];
  versionId: string;
  version: number;
  body: string;
  position: number;
  updatedAt: string;
  usable: boolean;
};
export type TemplateInput = {
  name: string;
  category: TemplateCategory;
  body: string;
  allowedRoleIds: string[];
};
export type RoleName = { id: string; name: string };

const one = (id: string) => `/api/v1/templates/${encodeURIComponent(id)}`;

export const templatesClient = {
  list: () => api.get<{ templates: TemplateView[]; roles?: RoleName[] }>("/api/v1/templates"),
  create: (b: TemplateInput) => api.post<TemplateView>("/api/v1/templates", b),
  update: (id: string, b: Partial<TemplateInput>) => api.patch<TemplateView>(one(id), b),
  archive: (id: string) => api.post<{ archived: true }>(`${one(id)}/archive`),
  restore: (id: string) => api.post<TemplateView>(`${one(id)}/restore`),
  reorder: (ids: string[]) => api.put<{ templates: TemplateView[] }>("/api/v1/templates/order", { ids }),
  /** What a lead's preview needs, fetched once; every keystroke then renders locally. */
  context: (leadId: string) =>
    api.get<RenderContext>(`/api/v1/leads/${encodeURIComponent(leadId)}/messages/context`),
};
