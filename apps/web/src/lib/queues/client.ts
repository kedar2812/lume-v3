"use client";
import { api } from "@/lib/api";

/** Where a run's leads come from (4C): a saved view (in its order) or the leads selected on the list. */
/** A view (with `filters` when it has changes not saved yet: what's shown), or a selection. */
export type QueueSource = { viewId: string; filters?: Record<string, string> } | { leadIds: string[] };
export type QueueStatus = "active" | "paused" | "finished" | "cancelled";
export type QueueItemStatus = "pending" | "sending" | "sent" | "not_sent" | "skipped";
export type QueueItem = {
  position: number;
  leadId: string;
  name: string;
  stageName: string | null;
  status: QueueItemStatus;
  reason: string | null;
};
export type QueueView = {
  id: string;
  status: QueueStatus;
  /** "daily_cap": LUME paused it until tomorrow; null: the person did. */
  pausedReason: string | null;
  templateName: string | null;
  sourceName: string;
  total: number;
  done: { sent: number; notSent: number; skipped: number };
  today: { sent: number; cap: number };
  items: QueueItem[];
};
export type LeftOut = { name: string; reason: string };
/** A run before it starts: who'd be in, who's left out and why, today's count, and any run already open. */
export type QueuePlan = {
  total: number;
  leftOut: LeftOut[];
  more: number;
  today: { sent: number; cap: number };
  open: { id: string; status: QueueStatus; sourceName: string; done: number; total: number } | null;
};
export type QueueStep = {
  next: number | null;
  finished?: true;
  moved?: { stageId: string; stageName: string; fromStageId: string; undoable: boolean } | null;
  notMoved?: { code: string; message: string };
};

/** Said on window when a run starts, pauses, resumes or ends, so Resume (Today, the top bar) looks again. */
export const QUEUE_CHANGED = "lume:queue-changed";
export const queueChanged = () => window.dispatchEvent(new Event(QUEUE_CHANGED));

/** How far a run has got: every lead that's been dealt with, whichever way. */
export const doneOf = (q: Pick<QueueView, "done">) => q.done.sent + q.done.notSent + q.done.skipped;

const one = (id: string) => `/api/v1/queues/${encodeURIComponent(id)}`;
const item = (id: string, pos: number, what: string) => `${one(id)}/items/${pos}/${what}`;
export const queuesClient = {
  plan: (source: QueueSource) => api.post<QueuePlan>("/api/v1/queues/plan", source),
  start: (source: QueueSource, templateId?: string) =>
    api.post<{ queue: QueueView; leftOut: LeftOut[]; more: number }>("/api/v1/queues", {
      ...source,
      ...(templateId ? { templateId } : {}),
    }),
  current: () => api.get<QueueView | null>("/api/v1/queues/current"),
  get: (id: string) => api.get<QueueView>(one(id)),
  /** A lead's words before Send, from the version the run planned with; or why it can't be sent now. */
  text: (id: string, pos: number) =>
    api.get<{ text: string; missing: string[] } | { unavailable: string }>(item(id, pos, "text")),
  prepare: (id: string, pos: number, text?: string) =>
    api.post<{ url: string; text: string } | ({ skipped: string } & QueueStep)>(
      item(id, pos, "prepare"),
      text === undefined ? {} : { text },
    ),
  sent: (id: string, pos: number) => api.post<QueueStep>(item(id, pos, "sent")),
  notSent: (id: string, pos: number) => api.post<QueueStep>(item(id, pos, "not-sent")),
  skip: (id: string, pos: number) => api.post<QueueStep>(item(id, pos, "skip")),
  /** A lead answered Not sent, tried again (a finished run opens again for it). */
  retry: (id: string, pos: number) => api.post<QueueStep>(item(id, pos, "retry")),
  pause: (id: string) => api.post<QueueView>(`${one(id)}/pause`),
  resume: (id: string) => api.post<QueueView>(`${one(id)}/resume`),
  cancel: (id: string) => api.post<QueueView>(`${one(id)}/cancel`),
};
