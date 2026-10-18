"use client";
import { api } from "@/lib/api";
import type { IntegrationsView } from "@/lib/sheets/types";
import type { AiStatus, AiUnavailable, Applied, CatchUpRead, LeadAi, NextStepRead, Part } from "./types";

const lead = (id: string) => `/api/v1/leads/${encodeURIComponent(id)}/ai`;
const read = (id: string) => `/api/v1/ai/reads/${encodeURIComponent(id)}`;

/** LUME AI (spec 2026-10-18): its status and switch, a next step from a note, and a lead's catch-up. */
export const aiClient = {
  status: () => api.get<AiStatus>("/api/v1/ai"),
  setEnabled: (enabled: boolean) => api.put<IntegrationsView>("/api/v1/integrations/ai", { enabled }),
  lead: (leadId: string) => api.get<LeadAi>(lead(leadId)),
  nextStep: (leadId: string, activityId: string) =>
    api.post<NextStepRead | AiUnavailable>(`${lead(leadId)}/next-step`, { activityId }),
  apply: (readId: string, parts: Record<Part, boolean>) => api.post<Applied>(`${read(readId)}/apply`, parts),
  dismiss: (readId: string) => api.post<{ dismissed: true }>(`${read(readId)}/dismiss`),
  catchUp: (leadId: string) => api.post<CatchUpRead | AiUnavailable>(`${lead(leadId)}/catch-up`),
};
