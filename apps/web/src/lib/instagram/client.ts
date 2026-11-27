"use client";
import { api } from "@/lib/api";
import type { IntegrationsView } from "@/lib/sheets/types";
import type {
  IgAccounts,
  IgCommentState,
  IgInboxMessage,
  IgInboxPerson,
  IgMessage,
  IgThread,
  IgAiGoal,
} from "./types";

const account = (id: string) => `/api/v1/instagram/accounts/${encodeURIComponent(id)}`;
const lead = (id: string) => `/api/v1/leads/${encodeURIComponent(id)}/instagram`;

/** Instagram (plan 2026-11-25-instagram-screens): the switch and the accounts, for admins. */
export const instagramClient = {
  setEnabled: (enabled: boolean) => api.put<IntegrationsView>("/api/v1/integrations/instagram", { enabled }),
  connect: () => api.post<{ url: string }>("/api/v1/instagram/connect"),
  /** The relay's hand-back (`?p=&s=`): single use, so the page calls it once. */
  complete: (b: { p: string; s: string }) => api.post<IgAccounts>("/api/v1/instagram/connect/complete", b),
  accounts: () => api.get<IgAccounts>("/api/v1/instagram/accounts"),
  setAccount: (
    id: string,
    b: { ownerId?: string | null; newDmCreatesLead?: boolean; newDms?: "team" | "ai" },
  ) => api.patch<IgAccounts>(account(id), b),
  /** Who replied's "Let LUME AI handle these" for Instagram leads: given to each account's LUME AI, or skipped with why. */
  handToAi: (leadIds: string[]) =>
    api.post<{ given: number; skipped: { leadId: string; why: string }[] }>("/api/v1/instagram/ai/handle", {
      leadIds,
    }),
  /** What LUME AI aims for in the Instagram conversations it takes. */
  setAiGoal: (goal: IgAiGoal) => api.put<{ goal: IgAiGoal }>("/api/v1/instagram/ai-goal", { goal }),
  disconnect: (id: string) => api.del<IgAccounts>(account(id)),
  /** A lead's conversations (D2): each with its account, Meta's window now, who has it, its comments and messages. */
  threads: (leadId: string) => api.get<{ threads: IgThread[] }>(lead(leadId)),
  /** A reply as a person: `clientKey` makes a retried send the same message, never a second one. */
  send: (leadId: string, b: { clientKey: string; threadId: string; text: string; retryOf?: string }) =>
    api.post<{ message: IgMessage }>(`${lead(leadId)}/messages`, b),
  /** A comment's one private reply. */
  privateReply: (commentId: string, b: { clientKey: string; text: string }) =>
    api.post<{ message: IgMessage }>(
      `/api/v1/instagram/comments/${encodeURIComponent(commentId)}/private-reply`,
      b,
    ),
  /** A person's actions on a comment (2026-11-27): one call to Instagram each. */
  replyPublicly: (commentId: string, text: string) =>
    api.post<IgCommentState>(`/api/v1/instagram/comments/${encodeURIComponent(commentId)}/public-reply`, {
      text,
    }),
  hideComment: (commentId: string, hidden: boolean) =>
    api.post<IgCommentState>(`/api/v1/instagram/comments/${encodeURIComponent(commentId)}/hide`, { hidden }),
  deleteComment: (commentId: string) =>
    api.del<IgCommentState>(`/api/v1/instagram/comments/${encodeURIComponent(commentId)}`),
  takeOver: (threadId: string) =>
    api.post<{ takenOver: { id: string; name: string } | null }>(
      `/api/v1/instagram/threads/${encodeURIComponent(threadId)}/take-over`,
    ),
  handBack: (threadId: string) =>
    api.post<{ takenOver: { id: string; name: string } | null }>(
      `/api/v1/instagram/threads/${encodeURIComponent(threadId)}/hand-back`,
    ),
  /** Not a lead yet (D5): newest first, a page at a time (`before`: the oldest lastAt shown). */
  inbox: (before?: string) =>
    api.get<{ people: IgInboxPerson[] }>(
      `/api/v1/instagram/inbox${before ? `?before=${encodeURIComponent(before)}` : ""}`,
    ),
  inboxPerson: (threadId: string) =>
    api.get<{ messages: IgInboxMessage[] }>(`/api/v1/instagram/inbox/${encodeURIComponent(threadId)}`),
  makeLead: (threadId: string) =>
    api.post<{ leadId: string }>(`/api/v1/instagram/inbox/${encodeURIComponent(threadId)}/lead`),
  ignore: (threadId: string) =>
    api.post<{ ignored: true }>(`/api/v1/instagram/inbox/${encodeURIComponent(threadId)}/ignore`),
  people: () => api.get<{ people: { id: string; name: string; active: boolean }[] }>("/api/v1/people"),
};
