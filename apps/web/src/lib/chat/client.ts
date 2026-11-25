"use client";
import type { Look } from "@/lib/avatar/look";
import { api } from "@/lib/api";

/** Team Chat as the API answers it (plan 2026-11-24-team-chat-2a, Tasks 3 to 6). */
export type PersonLite = {
  id: string;
  name: string;
  avatar: Look;
};
export type ConvRow = {
  id: string;
  kind: "channel" | "direct" | "lead";
  name: string | null;
  topic: string | null;
  unread: number;
  muted: boolean;
  lastAt: string | null;
  people?: PersonLite[];
  lead?: { id: string; name: string; stage: string | null };
};
export type ListKey = "channels" | "direct" | "leads";
export type ChatList = {
  channels: ConvRow[];
  direct: ConvRow[];
  leads: ConvRow[];
  folds: Record<ListKey, boolean>;
  unread: number;
};
export type FileView = { id: string; name: string; mime: string; kind: string; size: number; url: string };
export type MessageView = {
  id: number;
  conversationId: string;
  authorId: string | null;
  /** The id one's own message was sent with; null on everyone else's. */
  clientId: string | null;
  kind: "text" | "system";
  body: string | null;
  replyTo: { id: number; authorId: string | null; body: string | null } | null;
  files: FileView[];
  reactions: { emoji: string; count: number; mine: boolean }[];
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
};
export type MemberMark = { userId: string; lastReadId: number; lastDeliveredId: number };
export type MessagePage = {
  messages: MessageView[];
  /** Older ones before the first here (newer after the last, when asked with `after`). */
  more: boolean;
  /** Where the person had read up to; null when they keep no place here. */
  lastReadId: number | null;
  /** The other people's marks, in a direct message. */
  members: MemberMark[];
};
export type GroupRef = { kind: "everyone" | "team" | "role"; id?: string };
export type ManagedChannel = {
  id: string;
  name: string;
  topic: string | null;
  archived: boolean;
  people: string[];
  members: number;
  groups: GroupRef[];
};
export type ChannelAdmin = {
  channels: ManagedChannel[];
  teams: { id: string; name: string }[];
  roles: { id: string; name: string }[];
};

const conv = (id: string) => `/api/v1/chat/${encodeURIComponent(id)}`;
const msg = (id: number) => `/api/v1/chat/messages/${id}`;

export const chatClient = {
  list: () => api.get<ChatList>("/api/v1/chat"),
  one: (id: string) => api.get<ConvRow>(conv(id)),
  /** The sidebar's number, and which conversations never add to it. */
  unread: () => api.get<{ unread: number; muted: string[] }>("/api/v1/chat/unread"),
  channels: () => api.get<ChannelAdmin>("/api/v1/chat/channels"),
  makeChannel: (b: { name: string; topic?: string; people: string[]; groups: GroupRef[] }) =>
    api.post<{ id: string }>("/api/v1/chat/channels", b),
  changeChannel: (id: string, b: { name?: string; topic?: string; archived?: boolean }) =>
    api.patch<{ id: string }>(`/api/v1/chat/channels/${encodeURIComponent(id)}`, b),
  setMembers: (id: string, b: { people: string[]; groups: GroupRef[] }) =>
    api.put<{ id: string }>(`/api/v1/chat/channels/${encodeURIComponent(id)}/members`, b),
  fold: (list: ListKey, folded: boolean) => api.put<void>("/api/v1/chat/folds", { list, folded }),
  mute: (id: string, muted: boolean) => api.put<void>(`${conv(id)}/mute`, { muted }),
  direct: (people: string[]) => api.post<{ id: string }>("/api/v1/chat/direct", { people }),
  leadThread: (leadId: string) =>
    api.post<{ id: string }>(`/api/v1/chat/leads/${encodeURIComponent(leadId)}`),
  page: (id: string, q: { before?: number; after?: number } = {}) =>
    api.get<MessagePage>(
      `${conv(id)}/messages${q.before ? `?before=${q.before}` : q.after !== undefined ? `?after=${q.after}` : ""}`,
    ),
  send: (id: string, body: { clientId: string; body?: string; replyTo?: number; files?: string[] }) =>
    api.post<MessageView>(`${conv(id)}/messages`, body),
  edit: (mid: number, body: string) => api.patch<MessageView>(msg(mid), { body }),
  remove: (mid: number) => api.del<void>(msg(mid)),
  react: (mid: number, emoji: string, on: boolean) =>
    on
      ? api.put<void>(`${msg(mid)}/reactions/${encodeURIComponent(emoji)}`)
      : api.del<void>(`${msg(mid)}/reactions/${encodeURIComponent(emoji)}`),
  read: (id: string, upTo: number) => api.put<void>(`${conv(id)}/read`, { upTo }),
  delivered: (id: string, upTo: number) => api.put<void>(`${conv(id)}/delivered`, { upTo }),
  typing: (id: string) => api.post<void>(`${conv(id)}/typing`),
  online: () => api.get<{ online: string[] }>("/api/v1/chat/online"),
  upload: (file: File) => api.upload<{ file: FileView }>("/api/v1/chat/files", file),
};
