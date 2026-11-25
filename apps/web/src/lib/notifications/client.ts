"use client";
import { api } from "@/lib/api";

/** One of a person's notifications (Phase 3 spec §4): a lead's name at most, never a contact detail. */
export type NotificationView = {
  id: number;
  kind: string;
  title: string;
  body: string | null;
  leadId: string | null;
  taskId: string | null;
  createdAt: string;
  read: boolean;
  /** A security alert's id (6A), so Review opens it. Absent from an API before the watch. */
  alertId?: string | null;
  /** Team Chat's (2B): the conversation it opens, and the thread in it. */
  chat?: { conversation: string; thread: number | null };
};

/** Where a chat notice opens. Its own id, so the same conversation asked for again opens again. */
export const chatHref = (n: { id: number; chat: { conversation: string; thread: number | null } }) =>
  `/chat?c=${encodeURIComponent(n.chat.conversation)}${n.chat.thread ? `&t=${n.chat.thread}` : ""}&n=${n.id}`;

/**
 * Said on the window whenever LUME learns how many are unread (a read, Mark all read, the centre loading),
 * with that count as `detail.unread`, so the bell and the window title keep up.
 */
export const READ_EVENT = "lume:notifications-read";
export const sayUnread = (unread: number) => {
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent(READ_EVENT, { detail: { unread } }));
};

const said = <T extends { ok: boolean; data?: { unread: number } }>(r: T) => {
  if (r.ok && r.data) sayUnread(r.data.unread);
  return r;
};

export const notificationsClient = {
  list: () => api.get<{ items: NotificationView[]; unread: number }>("/api/v1/notifications"),
  read: async (ids: number[]) =>
    said(await api.post<{ unread: number }>("/api/v1/notifications/read", { ids })),
  readAll: async () => said(await api.post<{ unread: number }>("/api/v1/notifications/read", { all: true })),
  /** "Clear read": every read notification leaves the list; the ids are kept for Undo. */
  clearRead: () => api.post<{ cleared: number[] }>("/api/v1/notifications/clear-read"),
  undoClear: (ids: number[]) =>
    api.post<{ restored: number }>("/api/v1/notifications/clear-read/undo", { ids }),
};

/** Asks the bell to open the notification centre (Search's "Open notifications"; the top bar listens). */
export const OPEN_NOTIFICATIONS = "lume:open-notifications";
