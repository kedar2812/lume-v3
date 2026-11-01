"use client";
import type { LeadState } from "@lume/core/shared";
import { api } from "@/lib/api";
import type { AutopilotSetup, Estimate, RunBody, RunDetail, RunsList, RunView, StartResult } from "./types";

const run = (id: string) => `/api/v1/autopilot/runs/${encodeURIComponent(id)}`;
const lead = (id: string, leadId: string) => `${run(id)}/leads/${encodeURIComponent(leadId)}`;
const ask = (id: string) => `/api/v1/autopilot/asks/${encodeURIComponent(id)}`;
type LeadMoved = { leadId: string; state: LeadState; draft?: string | null };
/** Where one lead stands with LUME AI (2026-11-01). */
export type LeadStanding =
  | { run: null }
  | { run: { id: string; status: "running" | "paused" | "ended" }; state: LeadState; canDecide: boolean };

/** Autopilot (spec 2026-10-19 §1–§2): start LUME AI on leads, watch a run, and step in. The server decides every rule. */
export const autopilotClient = {
  setup: () => api.get<AutopilotSetup>("/api/v1/autopilot/setup"),
  estimate: (body: RunBody) => api.post<Estimate>("/api/v1/autopilot/estimate", body),
  start: (body: RunBody) => api.post<StartResult>("/api/v1/autopilot/runs", body),
  runs: () => api.get<RunsList>("/api/v1/autopilot/runs"),
  run: (id: string) => api.get<RunDetail>(run(id)),
  pause: (id: string) => api.post<{ run: RunView }>(`${run(id)}/pause`),
  resume: (id: string) => api.post<{ run: RunView }>(`${run(id)}/resume`),
  end: (id: string) => api.post<{ run: RunView }>(`${run(id)}/end`),
  takeOver: (id: string, leadId: string) => api.post<LeadMoved>(`${lead(id, leadId)}/take-over`),
  handBack: (id: string, leadId: string) => api.post<LeadMoved>(`${lead(id, leadId)}/hand-back`),
  carryOn: (id: string, leadId: string) => api.post<LeadMoved>(`${lead(id, leadId)}/carry-on`),
  /** Where one lead stands with LUME AI (2026-11-01): the run it's active in, its state, and whether carry on is yours. */
  leadState: (leadId: string) =>
    api.get<LeadStanding>(`/api/v1/leads/${encodeURIComponent(leadId)}/autopilot`),
  approve: (askId: string) => api.post<{ approved: true }>(`${ask(askId)}/approve`),
  decline: (askId: string) => api.post<{ declined: true }>(`${ask(askId)}/decline`),
};
