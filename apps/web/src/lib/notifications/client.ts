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
};

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
};
