import { can } from "@lume/core/shared";
import { ChatScreen, type ChatPerson } from "@/components/chat/ChatScreen";
import type { ChatList } from "@/lib/chat/client";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Chat · LUME" };

const NONE: ChatList = {
  channels: [],
  direct: [],
  leads: [],
  folds: { channels: false, direct: false, leads: false },
  threads: { any: false, unread: 0 },
  unread: 0,
};

/** Team Chat (plan 2026-11-24-team-chat-2a, Task 7): everyone who chats; `?c=` opens a conversation, `&t=` a thread in it. */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; t?: string; n?: string }>;
}) {
  const session = await requirePermission("chat.use");
  const { c, t, n } = await searchParams;
  const thread = typeof t === "string" && /^[1-9]\d{0,15}$/.test(t) ? Number(t) : null;
  const [list, people] = await Promise.all([
    apiGet<ChatList>("/api/v1/chat"),
    apiGet<{ people: ChatPerson[] }>("/api/v1/chat/people"),
  ]);
  return (
    <ChatScreen
      initial={list.data ?? NONE}
      people={people.data?.people ?? []}
      me={session.user.id}
      zone={session.user.zone ?? session.user.timezone ?? "UTC"}
      openId={typeof c === "string" ? c : null}
      thread={typeof c === "string" ? thread : null}
      asked={typeof n === "string" ? n : null}
      canManage={can(session.actor, "chat.channels.manage")}
    />
  );
}
