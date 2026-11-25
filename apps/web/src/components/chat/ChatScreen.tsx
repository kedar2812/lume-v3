"use client";
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { lookOf, type Look } from "@/lib/avatar/look";
import { chatClient, type ChatList, type ConvRow, type ListKey } from "@/lib/chat/client";
import { subscribeChat, subscribePresence } from "@/lib/notifications/stream";
import { isViewing, tellMuted, threadKey } from "@/lib/chat/viewing";
import { usePhone } from "@/lib/usePhone";
import type { Who } from "./Bubble";
import { Conversation } from "./Conversation";
import { ConvList } from "./ConvList";
import { Channels, NewDirect } from "./Sheets";
import { Threads } from "./Threads";
import s from "./chat.module.css";

export type ChatPerson = { id: string; name: string; avatar: Look | null; active?: boolean };

/** How seldom the list asks the server again when nothing but messages came. */
export const SLOW_MS = 30_000;
const spread = (ms: number) => Math.floor(Math.random() * ms);
/** Direct messages that arrived while no one was listening have reached this device now: said once for each. */
const receivedAt = new Map<string, string | null>();
const receivedDirect = (l: ChatList) => {
  for (const c of l.direct) {
    if (c.unread === 0 || receivedAt.get(c.id) === c.lastAt) continue;
    receivedAt.set(c.id, c.lastAt);
    void chatClient.delivered(c.id, Number.MAX_SAFE_INTEGER);
  }
};

/**
 * Team Chat (plan 2026-11-24-team-chat-2a, Task 7; approved canvas KTQD9PJ… v6): the conversations on the left, the open
 * one on the right (on a phone, one then the other). Lives on the tab's one stream.
 */
export function ChatScreen({
  initial,
  people,
  me,
  zone,
  openId: firstOpen,
  thread: firstThread = null,
  asked = null,
  canManage = false,
}: {
  initial: ChatList;
  people: ChatPerson[];
  me: string;
  zone: string;
  openId: string | null;
  /** A thread to open beside it. */
  thread?: number | null;
  /** Which press asked for them: the same conversation asked for again opens again. */
  asked?: string | null;
  /** Makes and changes channels. */
  canManage?: boolean;
}) {
  const [list, setList] = useState(initial);
  const all = [...list.channels, ...list.direct, ...list.leads];
  const [openId, setOpenId] = useState<string | null>(firstOpen);
  /** Open, and not (or not yet) in the list: a lead's thread from a link, a direct message just started. */
  const [extra, setExtra] = useState<ConvRow | null>(null);
  const [sheet, setSheet] = useState<"direct" | "channels" | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  /** The message whose thread is open beside its conversation. */
  const [thread, setThread] = useState<number | null>(firstThread);
  /** Their threads are on the right, in the place of a conversation. */
  const [threads, setThreads] = useState(false);
  const phone = usePhone();
  const [online, setOnline] = useState<ReadonlySet<string>>(new Set());
  const who = useMemo(
    () =>
      new Map<string, Who>(
        people.map((p) => [p.id, { name: p.name, active: p.active !== false, ...lookOf(p.id, p.avatar) }]),
      ),
    [people],
  );

  // The list reads itself again after a change only the server can say (someone joins, a message is deleted); a message
  // in a conversation it has is counted here, so a busy channel asks the server nothing.
  const listRef = useRef(list);
  listRef.current = list;
  const pending = useRef<{ t: ReturnType<typeof setTimeout>; at: number } | null>(null);
  const refresh = useCallback((inMs = 1000) => {
    const at = Date.now() + inMs;
    if (pending.current) {
      // Already coming sooner.
      if (pending.current.at <= at) return;
      clearTimeout(pending.current.t);
    }
    const t = setTimeout(async () => {
      pending.current = null;
      const r = await chatClient.list();
      // Not now: again in a while.
      if (!r.ok) return refresh(SLOW_MS);
      setList(r.data);
      receivedDirect(r.data);
    }, inMs);
    pending.current = { t, at };
  }, []);
  useEffect(() => () => clearTimeout(pending.current?.t), []);
  useEffect(() => receivedDirect(initial), [initial]);

  const openRef = useRef<string | null>(null);
  useEffect(
    () =>
      subscribeChat((e) => {
        if (e.c === "*") return refresh(0);
        if (e.e === "message" && e.c) {
          // A direct message reached this device: its sender sees Delivered.
          if (e.d && e.u !== me && e.m) void chatClient.delivered(e.c, e.m);
          const l = listRef.current;
          if (![...l.channels, ...l.direct, ...l.leads].some((c) => c.id === e.c)) {
            // A lead's thread they may not follow asks seldom; anything else new is theirs, now.
            return refresh(e.l ? SLOW_MS + spread(SLOW_MS / 2) : 1000 + spread(1000));
          }
          const now = new Date().toISOString();
          const on = (c: ConvRow) =>
            c.id !== e.c
              ? c
              : { ...c, lastAt: now, unread: e.u === me || openRef.current === c.id ? 0 : c.unread + 1 };
          const newest = (a: ConvRow, b: ConvRow) => (b.lastAt ?? "").localeCompare(a.lastAt ?? "");
          setList((x) => ({
            ...x,
            channels: x.channels.map(on),
            direct: x.direct.map(on).sort(newest),
            leads: x.leads.map(on).sort(newest),
          }));
          // Once in a while, as the server counts it.
          refresh(SLOW_MS + spread(SLOW_MS / 2));
        } else if (e.e === "reply") {
          // It counts for those who follow the thread; one's own is read as it's sent.
          if (!e.f || e.t === undefined) return;
          if (e.u === me) return refresh(1000 + spread(1000));
          const l = listRef.current;
          const muted = [...l.channels, ...l.direct, ...l.leads].some((c) => c.id === e.c && c.muted);
          const counts = !muted && !isViewing(threadKey(e.t));
          setList((x) => ({ ...x, threads: { any: true, unread: x.threads.unread + (counts ? 1 : 0) } }));
          refresh(SLOW_MS + spread(SLOW_MS / 2));
        } else if (e.e === "read" && e.t !== undefined) {
          // A thread read, followed or left in another of their tabs.
          refresh(1000 + spread(1000));
        } else if (e.e === "members" || e.e === "changed") refresh(1000 + spread(e.w ?? 1000));
        else if (e.e === "deleted") refresh(SLOW_MS / 3 + spread(SLOW_MS / 3));
        else if (e.e === "read" && e.u === me && e.c) {
          const seen = (c: ConvRow) => (c.id === e.c ? { ...c, unread: 0 } : c);
          setList((x) => ({
            ...x,
            channels: x.channels.map(seen),
            direct: x.direct.map(seen),
            leads: x.leads.map(seen),
          }));
        }
      }),
    [me, refresh],
  );
  useEffect(() => {
    const read = () => void chatClient.online().then((r) => r.ok && setOnline(new Set(r.data.online)));
    read();
    const offChat = subscribeChat((e) => {
      // Who came and went while the stream was away was never said.
      if (e.c === "*") read();
    });
    const off = subscribePresence((p) =>
      setOnline((cur) => {
        if (cur.has(p.u) === p.on) return cur;
        const next = new Set(cur);
        if (p.on) next.add(p.u);
        else next.delete(p.u);
        return next;
      }),
    );
    return () => {
      offChat();
      off();
    };
  }, []);

  const onFold = (key: ListKey, folded: boolean) => {
    setList((l) => ({ ...l, folds: { ...l.folds, [key]: folded } }));
    void chatClient.fold(key, folded);
  };
  const listed = all.some((c) => c.id === openId);
  useEffect(() => {
    if (!openId || listed || extra?.id === openId) return;
    let live = true;
    void chatClient.one(openId).then((r) => {
      if (!live) return;
      if (r.ok) setExtra(r.data);
      else {
        // Taken out of it, archived, or never theirs to read.
        setGone(r.message);
        setOpenId(null);
      }
    });
    return () => {
      live = false;
    };
  }, [openId, listed, extra]);
  // On a computer the first channel is open until one is chosen; on a phone, the list comes first.
  const shownId = threads ? null : (openId ?? (phone || gone ? null : (list.channels[0]?.id ?? null)));
  const open = all.find((c) => c.id === shownId) ?? (extra?.id === shownId ? extra : null);
  openRef.current = open?.id ?? null;
  // A lead's thread open here stays open when it drops off the end of the list.
  const last = open?.kind === "lead" ? open : null;
  useEffect(() => {
    if (last) setExtra(last);
  }, [last?.id]);
  const onOpen = (id: string, root: number | null = null) => {
    setGone(null);
    setThreads(false);
    setThread(root);
    setOpenId(id);
  };
  // Opened from the bell while Chat is already on screen.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else if (firstOpen) onOpen(firstOpen, firstThread);
  }, [firstOpen, firstThread, asked]);
  const onMute = (id: string, muted: boolean) => {
    const on = (c: ConvRow) => (c.id === id ? { ...c, muted } : c);
    setList((l) => ({
      ...l,
      channels: l.channels.map(on),
      direct: l.direct.map(on),
      leads: l.leads.map(on),
    }));
    setExtra((x) => (x ? on(x) : x));
    void chatClient.mute(id, muted).then(() => {
      tellMuted();
      refresh();
    });
  };
  return (
    <div className={s.cx} data-full-canvas="" data-open={(openId && open) || threads ? "" : undefined}>
      <ConvList
        list={list}
        openId={shownId}
        online={online}
        onOpen={onOpen}
        onThreads={() => setThreads(true)}
        threadsOpen={threads}
        onNewDirect={() => setSheet("direct")}
        {...(canManage ? { onChannels: () => setSheet("channels") } : {})}
        onFold={onFold}
      />
      {threads ? (
        <Threads me={me} people={who} zone={zone} onOpen={onOpen} onBack={() => setThreads(false)} />
      ) : open ? (
        <Conversation
          key={open.id}
          conv={open}
          me={me}
          people={who}
          zone={zone}
          thread={thread}
          onThread={setThread}
          onBack={() => setOpenId(null)}
          {...(all.some((c) => c.id === open.id) ? { onMute: (m: boolean) => onMute(open.id, m) } : {})}
        />
      ) : (
        <section className={s.conv} aria-label="No conversation open">
          <div className={s.empty}>
            <p>{gone ?? "Choose a conversation."}</p>
          </div>
        </section>
      )}
      <AnimatePresence>
        {sheet === "direct" && (
          <NewDirect
            key="direct"
            people={people}
            me={me}
            onClose={() => setSheet(null)}
            onOpen={(id) => {
              setSheet(null);
              onOpen(id);
              refresh();
            }}
          />
        )}
        {sheet === "channels" && (
          <Channels
            key="channels"
            people={people}
            me={me}
            onClose={() => setSheet(null)}
            onChanged={(id) => {
              refresh();
              if (id) onOpen(id);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
