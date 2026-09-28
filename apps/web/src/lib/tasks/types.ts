import type { DuePreset, Recurrence, SnoozePreset } from "@lume/core/shared";

export type { DuePreset, Recurrence, SnoozePreset };
/** A follow-up, as the API returns it (Phase 3 spec §7). */
export type TaskView = {
  id: string;
  leadId: string;
  leadName: string;
  title: string;
  note: string | null;
  dueAt: string;
  status: "open" | "done" | "cancelled";
  remindMinutes: number[];
  recurrence: Recurrence | null;
  assignee: { id: string; name: string };
  createdBy: { id: string; name: string } | null;
  doneAt: string | null;
  canEdit: boolean;
};
/** A time as given, or one of Settings → Follow-ups' time choices by id (3C). */
export type Due = { at: string } | { preset: string };
export type TaskInput = {
  title?: string;
  note?: string | null;
  due?: Due;
  remindMinutes?: number[];
  recurrence?: Recurrence | null;
  assigneeId?: string;
};
export type DoneResult = { task: TaskView; next: TaskView | null; clearedToday: boolean };
export type TodayView = {
  overdue: TaskView[];
  soon: TaskView[];
  later: TaskView[];
  done: number;
  total: number;
  needsYou?: { unassigned: number; sources: { id: string; name: string; type: string }[] };
};
