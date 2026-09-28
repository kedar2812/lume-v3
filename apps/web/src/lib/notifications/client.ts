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

/** Said on the window when this person's notifications are all read, so the bell can let go of its dot. */
export const READ_EVENT = "lume:notifications-read";

export const notificationsClient = {
  list: () => api.get<{ items: NotificationView[]; unread: number }>("/api/v1/notifications"),
  readAll: async () => {
    const r = await api.post<{ unread: number }>("/api/v1/notifications/read", { all: true });
    if (r.ok && typeof window !== "undefined") window.dispatchEvent(new Event(READ_EVENT));
    return r;
  },
};
