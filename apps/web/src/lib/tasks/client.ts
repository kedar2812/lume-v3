"use client";
import { api } from "@/lib/api";
import type { DoneResult, SnoozePreset, TaskInput, TaskView, TodayView } from "./types";

const task = (id: string) => `/api/v1/tasks/${encodeURIComponent(id)}`;

export const tasksClient = {
  forLead: (leadId: string) =>
    api.get<{ items: TaskView[] }>(`/api/v1/leads/${encodeURIComponent(leadId)}/tasks`),
  create: (leadId: string, b: TaskInput) =>
    api.post<TaskView>(`/api/v1/leads/${encodeURIComponent(leadId)}/tasks`, b),
  update: (id: string, b: TaskInput) => api.patch<TaskView>(task(id), b),
  done: (id: string) => api.post<DoneResult>(`${task(id)}/done`),
  snooze: (id: string, b: { until: string } | { preset: SnoozePreset }) =>
    api.post<TaskView>(`${task(id)}/snooze`, b),
  cancel: (id: string) => api.post<TaskView>(`${task(id)}/cancel`),
  today: () => api.get<TodayView>("/api/v1/today"),
};
