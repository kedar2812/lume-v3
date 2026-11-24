"use client";
import type { FlowGraph, FlowProblem, FlowStep, GraphOp, KeywordMode } from "@lume/core/shared";
import { api } from "@/lib/api";

/** What starts a flow, as the API keeps it (plan 1B Task 3). */
export type FlowTrigger = {
  id?: string;
  kind: "comment" | "dm" | "story_reply" | "story_mention" | "ad" | "welcome";
  accountId: string | null;
  keywords: string[];
  mode: KeywordMode;
  mediaIds: string[];
  adIds: string[];
  publicReplies: string[];
  cooldownHours: number;
  enabled: boolean;
};

/** A way in as it's sent: the server's id is its own (new on every save) and its schema is strict. */
export const withoutId = (t: FlowTrigger): FlowTrigger => {
  const { id, ...rest } = t;
  void id;
  return rest;
};

/** One flow in the builder (GET /api/v1/instagram/flows/:id). */
export type FlowView = {
  id: string;
  name: string;
  status: "draft" | "live" | "paused" | "archived";
  priority: number;
  rev: number;
  draft: FlowStep[] | FlowGraph;
  /** The draft as the builder shows it: a 1B list laid out as a graph with the same step ids. */
  graph: FlowGraph;
  live: { version: number; steps: FlowStep[] | FlowGraph } | null;
  /** What stops it going live, in words. */
  problems: string[];
  /** The same on the graph, each with its step, warnings too. */
  issues: FlowProblem[];
  triggers: FlowTrigger[];
};

export type FlowVersion = {
  id: string;
  version: number;
  createdAt: string;
  createdBy: { id: string; name: string | null } | null;
  live: boolean;
  changes: { added: number; removed: number; changed: number };
};

/** Replay's list: someone who went through the flow lately, and how their latest run stands. */
export type FlowPerson = {
  leadId: string;
  name: string;
  photo: string | null;
  startedAt: string;
  status: string;
};

/** One run of a lead through the flow (Replay). */
export type FlowRun = {
  id: string;
  status: string;
  reason: string | null;
  version: number;
  startedAt: string;
  sent: number;
  trail: { step: string; at: string }[];
  waiting: null | { step: string | null; why: "reply" | "answer" | "time" | "message"; until: string | null };
};

export type FlowStats = {
  byStep: Record<string, { entered: number; people: number; sent: number }>;
  byLine: Record<string, number>;
};

/** What LUME AI answers (C1): its plan, what it did in LUME's words, and the steps; refused: nothing to play. */
export type FlowAiBuild = { plan: string[]; said: string; ops: GraphOp[]; refused: boolean };

const flow = (id: string) => `/api/v1/instagram/flows/${encodeURIComponent(id)}`;

export const flowsClient = {
  get: (id: string) => api.get<FlowView>(flow(id)),
  save: (id: string, body: { rev: number; graph?: FlowGraph; name?: string }) =>
    api.put<FlowView>(flow(id), body),
  publish: (id: string, rev: number) => api.post<FlowView>(`${flow(id)}/publish`, { rev }),
  /** The server's trigger ids are its own (new on every save) and its schema is strict: they're never sent back. */
  setTriggers: (id: string, rev: number, triggers: FlowTrigger[]) =>
    api.put<FlowView>(`${flow(id)}/triggers`, { rev, triggers: triggers.map(withoutId) }),
  versions: (id: string) => api.get<{ versions: FlowVersion[] }>(`${flow(id)}/versions`),
  restore: (id: string, versionId: string, rev: number) =>
    api.post<FlowView>(`${flow(id)}/versions/${encodeURIComponent(versionId)}/restore`, { rev }),
  /** The last `days` of the business's own days (its time zone decides where today ends). */
  stats: (id: string, days: number) => api.get<FlowStats>(`${flow(id)}/stats?days=${days}`),
  people: (id: string, q = "") =>
    api.get<{ people: FlowPerson[] }>(
      `${flow(id)}/people${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`,
    ),
  runs: (id: string, leadId: string) =>
    api.get<{ runs: FlowRun[] }>(`${flow(id)}/runs?lead=${encodeURIComponent(leadId)}`),
  /** A copy as a new draft flow: of today's draft, or of one version that went live. */
  duplicate: (id: string, versionId?: string) =>
    api.post<FlowView>(`${flow(id)}/duplicate`, versionId ? { versionId } : {}),
  /** LUME AI builds the flow (C1): steps to play into the draft, saved like any edit. Nothing is written by asking. */
  aiBuild: (id: string, body: { prompt: string; selection?: string[] }) =>
    api.post<FlowAiBuild>(`${flow(id)}/ai-build`, body),
  testKeyword: (body: { text: string; keywords: string[]; mode: KeywordMode; flowId?: string }) =>
    api.post<{
      starts: boolean;
      keyword: string | null;
      overlaps: { flowId: string; name: string; keyword: string }[];
    }>("/api/v1/instagram/flows/test-keyword", body),
};
