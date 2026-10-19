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
/** A template's words sent to WhatsApp for approval (W3b-2), for one WhatsApp account and language. */
export type WhatsAppSubmission = {
  id: string;
  versionId: string;
  /** Whether it's the template's words as they are now. */
  current: boolean;
  /** The numbers it covers, by how they show. */
  account: string;
  language: string;
  category: "MARKETING" | "UTILITY";
  status: "submitting" | "pending" | "approved" | "rejected" | "paused" | "disabled" | "failed";
  /** Why it was turned down or couldn't go, in LUME's words. */
  reason: string | null;
  submittedAt: string;
  decidedAt: string | null;
};

const one = (id: string) => `/api/v1/templates/${encodeURIComponent(id)}`;

export const templatesClient = {
  list: () => api.get<{ templates: TemplateView[]; roles?: RoleName[] }>("/api/v1/templates"),
  create: (b: TemplateInput) => api.post<TemplateView>("/api/v1/templates", b),
  update: (id: string, b: Partial<TemplateInput>) => api.patch<TemplateView>(one(id), b),
  archive: (id: string) => api.post<{ archived: true }>(`${one(id)}/archive`),
  restore: (id: string) => api.post<TemplateView>(`${one(id)}/restore`),
  reorder: (ids: string[]) => api.put<{ templates: TemplateView[] }>("/api/v1/templates/order", { ids }),
  /** Where the template stands with WhatsApp (W3b-2), and sending its current words for approval. */
  whatsapp: (id: string) =>
    api.get<{ on: boolean; submissions: WhatsAppSubmission[] }>(`${one(id)}/whatsapp`),
  submitToWhatsApp: (
    id: string,
    b: { language: string; category: "MARKETING" | "UTILITY"; headerFileId?: string },
  ) => api.post<{ on: boolean; submissions: WhatsAppSubmission[] }>(`${one(id)}/whatsapp`, b),
  /** What a lead's preview needs, fetched once; every keystroke then renders locally. */
  context: (leadId: string) =>
    api.get<RenderContext>(`/api/v1/leads/${encodeURIComponent(leadId)}/messages/context`),
};
