"use client";
import type { FlowGraph, FlowProblem, FlowStep, KeywordMode } from "@lume/core/shared";
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

export type FlowStats = {
  byStep: Record<string, { entered: number; people: number; sent: number }>;
  byLine: Record<string, number>;
};

const flow = (id: string) => `/api/v1/instagram/flows/${encodeURIComponent(id)}`;

export const flowsClient = {
  get: (id: string) => api.get<FlowView>(flow(id)),
  save: (id: string, body: { rev: number; graph?: FlowGraph; name?: string }) =>
    api.put<FlowView>(flow(id), body),
  publish: (id: string, rev: number) => api.post<FlowView>(`${flow(id)}/publish`, { rev }),
  setTriggers: (id: string, rev: number, triggers: FlowTrigger[]) =>
    api.put<FlowView>(`${flow(id)}/triggers`, { rev, triggers }),
  versions: (id: string) => api.get<{ versions: FlowVersion[] }>(`${flow(id)}/versions`),
  restore: (id: string, versionId: string, rev: number) =>
    api.post<FlowView>(`${flow(id)}/versions/${encodeURIComponent(versionId)}/restore`, { rev }),
  stats: (id: string, from: string, to: string) =>
    api.get<FlowStats>(`${flow(id)}/stats?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  testKeyword: (body: { text: string; keywords: string[]; mode: KeywordMode; flowId?: string }) =>
    api.post<{
      starts: boolean;
      keyword: string | null;
      overlaps: { flowId: string; name: string; keyword: string }[];
    }>("/api/v1/instagram/flows/test-keyword", body),
};
