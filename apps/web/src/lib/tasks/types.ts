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
/** One of today's calls (5C, 5D): the caller's own meetings starting today on their clock. */
export type TodayMeeting = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  link: string | null;
  status: "scheduled" | "completed" | "no_show" | "rescheduled" | "cancelled";
  lead: { id: string; name: string } | null;
  matchedBy: "attendee" | "title" | "calendar" | "calendly";
  /** Its WhatsApp reminder (the stage rule's): when it's due, or when it was sent. */
  reminder: { at: string; sent: boolean } | null;
};
export type TodayView = {
  overdue: TaskView[];
  soon: TaskView[];
  later: TaskView[];
  done: number;
  total: number;
  /** Today's calls (absent from an API that predates them). */
  meetings?: TodayMeeting[];
  /** Follow-ups done today, with when each was due (the green dots on the day's line). */
  doneToday?: { id: string; title: string; dueAt: string; leadId: string; leadName: string }[];
  needsYou?: {
    unassigned: number;
    /** When the oldest lead with no one arrived (absent from an older API). */
    unassignedOldest?: string | null;
    sources: { id: string; name: string; type: string }[];
    /** Open security alerts, for whoever looks after security (absent from an older API). */
    alerts?: number;
  };
};
