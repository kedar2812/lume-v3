"use client";
import { useSyncExternalStore } from "react";
import { chatClient, type FileView, type MessageView } from "./client";

/**
 * What this tab is sending (plan 2026-11-24-team-chat-2a): kept outside any screen, so a send that failed is still there
 * after looking at another conversation, and sends in a conversation go one after another, in the order they were
 * written. Each keeps its `clientId` for good, so trying again can only ever land once.
 */
export type Pending = MessageView & { pending: "sending" | "failed"; clientId: string; why?: string };
type Draft = { body: string | null; replyTo: MessageView["replyTo"]; files: FileView[] };

const NONE: readonly Pending[] = [];
const boxes = new Map<string, readonly Pending[]>();
const chains = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
/** The screens open on each conversation now: whichever it is when a send lands hears of it. */
const open = new Map<string, Set<(m: MessageView) => void>>();
export function onLanded(conv: string, f: (m: MessageView) => void): () => void {
  const set = open.get(conv) ?? new Set();
  open.set(conv, set.add(f));
  return () => {
    set.delete(f);
    if (!set.size) open.delete(conv);
  };
}
const set = (conv: string, f: (xs: readonly Pending[]) => readonly Pending[]) => {
  const next = f(boxes.get(conv) ?? NONE);
  if (next.length) boxes.set(conv, next);
  else boxes.delete(conv);
  for (const l of listeners) l();
};
let local = 0;

/** Sends it after whatever this conversation is already sending. */
function go(conv: string, p: Pending): void {
  const run = async () => {
    const r = await chatClient.send(conv, {
      clientId: p.clientId,
      ...(p.body ? { body: p.body } : {}),
      ...(p.replyTo ? { replyTo: p.replyTo.id } : {}),
      ...(p.files.length ? { files: p.files.map((f) => f.id) } : {}),
    });
    if (r.ok) {
      for (const f of open.get(conv) ?? []) f(r.data);
      set(conv, (xs) => xs.filter((x) => x.clientId !== p.clientId));
    } else
      set(conv, (xs) =>
        xs.map((x) => (x.clientId === p.clientId ? { ...x, pending: "failed" as const, why: r.message } : x)),
      );
  };
  const next = (chains.get(conv) ?? Promise.resolve()).then(run, run);
  chains.set(conv, next);
  void next.finally(() => {
    if (chains.get(conv) === next) chains.delete(conv);
  });
}

export function sendInto(conv: string, me: string, d: Draft): void {
  const p: Pending = {
    // Below every real id: never mistaken for one.
    id: -++local,
    conversationId: conv,
    authorId: me,
    clientId: crypto.randomUUID(),
    kind: "text",
    body: d.body,
    replyTo: d.replyTo,
    files: d.files,
    reactions: [],
    editedAt: null,
    deletedAt: null,
    createdAt: new Date().toISOString(),
    pending: "sending",
  };
  set(conv, (xs) => [...xs, p]);
  go(conv, p);
}

export function retry(conv: string, clientId: string): void {
  const p = (boxes.get(conv) ?? NONE).find((x) => x.clientId === clientId);
  if (!p || p.pending === "sending") return;
  const again = { ...p, pending: "sending" as const };
  set(conv, (xs) => xs.map((x) => (x.clientId === clientId ? again : x)));
  go(conv, again);
}
export const discard = (conv: string, clientId: string) =>
  set(conv, (xs) => xs.filter((x) => x.clientId !== clientId));

/** What's being sent, or couldn't go, in a conversation. */
export function usePending(conv: string): readonly Pending[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => boxes.get(conv) ?? NONE,
    () => NONE,
  );
}
