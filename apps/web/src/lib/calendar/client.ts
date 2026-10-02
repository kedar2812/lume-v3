"use client";
import { api } from "@/lib/api";
import type { Pipeline } from "@/lib/leads/types";
import type { IntegrationsView } from "@/lib/sheets/types";
import type {
  CalendarConnection,
  CalendarRules,
  CalendlySettings,
  CalendlyView,
  Meeting,
  MeetingPatch,
  MeetingsQuery,
  SyncQueued,
} from "./types";

const CALENDLY = "/api/v1/integrations/calendly";
const CONNECTION = "/api/v1/calendar/connection";

/** Only the filters given, so the server's own defaults apply to the rest. */
function meetingsUrl(q: MeetingsQuery): string {
  const p = new URLSearchParams({ from: q.from.toISOString(), to: q.to.toISOString() });
  for (const k of ["ownerId", "pipelineId", "stageId"] as const) if (q[k]) p.set(k, q[k]);
  return `/api/v1/meetings?${p.toString()}`;
}

/** Every call the Calendar screens make (Phase 5D). Each returns ApiResult, so a refusal is shown as it is. */
export const calendarClient = {
  // A person's own Google Calendar.
  connection: () => api.get<CalendarConnection>(CONNECTION),
  /** Where to send the browser: the relay's Google consent. */
  connect: () => api.post<{ url: string }>("/api/v1/calendar/connect"),
  /** The relay's hand-back (`/calendar/connected?p=&s=`). */
  complete: (b: { p: string; s: string }) => api.post<CalendarConnection>("/api/v1/calendar/complete", b),
  chooseCalendars: (calendars: string[]) => api.patch<CalendarConnection>(CONNECTION, { calendars }),
  /** Refresh: wait for a `lastSync.at` newer than `since`. */
  sync: () => api.post<SyncQueued>(`${CONNECTION}/sync`),
  disconnect: () => api.del<CalendarConnection>(CONNECTION),
  /** The module switch in Settings → Integrations. */
  setEnabled: (enabled: boolean) =>
    api.put<IntegrationsView>("/api/v1/integrations/google-calendar", { enabled }),

  // Meetings with leads.
  meetings: (q: MeetingsQuery) => api.get<{ meetings: Meeting[] }>(meetingsUrl(q)),
  leadMeetings: (leadId: string) =>
    api.get<{ meetings: Meeting[] }>(`/api/v1/leads/${encodeURIComponent(leadId)}/meetings`),
  /** Attach to a lead, or Log outcome (once, after it started). */
  patchMeeting: (id: string, patch: MeetingPatch) =>
    api.patch<Meeting>(`/api/v1/meetings/${encodeURIComponent(id)}`, patch),

  // The business's Calendly (integrations.manage).
  calendly: () => api.get<CalendlyView>(CALENDLY),
  connectCalendly: (token: string) => api.post<CalendlyView>(CALENDLY, { token }),
  patchCalendly: (p: Partial<CalendlySettings>) => api.patch<CalendlyView>(CALENDLY, p),
  disconnectCalendly: () => api.del<CalendlyView>(CALENDLY),

  // Settings → Calendar's rules (settings.manage), saved whole.
  rules: () => api.get<{ rules: CalendarRules }>("/api/v1/settings/calendar"),
  saveRules: (rules: CalendarRules) =>
    api.put<{ rules: CalendarRules }>("/api/v1/settings/calendar", { rules }),

  /** The stage a Calendly booking moves its lead to; null for none. */
  bookingStage: (pipelineId: string, stageId: string | null) =>
    api.patch<{ pipeline: Pipeline }>(`/api/v1/pipelines/${encodeURIComponent(pipelineId)}`, {
      bookingStageId: stageId,
    }),
};
