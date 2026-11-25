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
  unread: 0,
};

/** Team Chat (plan 2026-11-24-team-chat-2a, Task 7): everyone who chats; `?c=` opens a conversation. */
export default async function Page({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const session = await requirePermission("chat.use");
  const { c } = await searchParams;
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
      canManage={can(session.actor, "chat.channels.manage")}
    />
  );
}
