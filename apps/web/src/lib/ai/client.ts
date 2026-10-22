"use client";
import { api } from "@/lib/api";
import type { IntegrationsView } from "@/lib/sheets/types";
import type { AiProfilePatch } from "@lume/core/shared";
import type {
  AiProfileView,
  AiStatus,
  AiUnavailable,
  Applied,
  CatchUpRead,
  LeadAi,
  NextStepRead,
  Part,
} from "./types";

const lead = (id: string) => `/api/v1/leads/${encodeURIComponent(id)}/ai`;
const read = (id: string) => `/api/v1/ai/reads/${encodeURIComponent(id)}`;

/** LUME AI (spec 2026-10-18): its status and switch, a next step from a note, and a lead's catch-up. */
export const aiClient = {
  status: () => api.get<AiStatus>("/api/v1/ai"),
  /** Settings → LUME AI (admins; Autopilot A1): what it knows, its voice and the standing choices. */
  profile: () => api.get<AiProfileView>("/api/v1/ai/profile"),
  saveProfile: (patch: AiProfilePatch) => api.patch<AiProfileView>("/api/v1/ai/profile", patch),
  /** Ask the owner for more LUME AI this month (admins; Autopilot spec 2026-10-19 §4). */
  askTopUp: (note?: string) =>
    api.post<{ asked: true; already?: true }>("/api/v1/ai/topup", note ? { note } : {}),
  setEnabled: (enabled: boolean) => api.put<IntegrationsView>("/api/v1/integrations/ai", { enabled }),
  lead: (leadId: string) => api.get<LeadAi>(lead(leadId)),
  nextStep: (leadId: string, activityId: string) =>
    api.post<NextStepRead | AiUnavailable>(`${lead(leadId)}/next-step`, { activityId }),
  apply: (readId: string, parts: Record<Part, boolean>) => api.post<Applied>(`${read(readId)}/apply`, parts),
  dismiss: (readId: string) => api.post<{ dismissed: true }>(`${read(readId)}/dismiss`),
  catchUp: (leadId: string) => api.post<CatchUpRead | AiUnavailable>(`${lead(leadId)}/catch-up`),
};
