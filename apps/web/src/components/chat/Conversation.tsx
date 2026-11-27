"use client";
import { CHAT_LIMITS, plainOf, repliesWords, runsOf, ticksOf, typingWords } from "@lume/core/shared";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  chatClient,
  type ConvRow,
  type FileView,
  type Mentionable,
  type MessageView,
} from "@/lib/chat/client";
import { discard, retry, sendInto, usePending } from "@/lib/chat/outbox";
import { threadKey } from "@/lib/chat/viewing";
import { subscribeChat } from "@/lib/notifications/stream";
import { Bubble, type Shown, type Who } from "./Bubble";
import { Composer } from "./Composer";
import { convName } from "./ConvList";
import { optionsFor } from "./MentionMenu";
import { useMessages } from "./useMessages";
import { dayKey, dayWords, lastWords, timeOf } from "./when";
import s from "./chat.module.css";

const NEAR = 40;
/** Narrower than this, a conversation and a thread don't fit side by side: the thread lies over it. */
const BESIDE = 720;

type Props = {
  conv: ConvRow;
  me: string;
  people: ReadonlyMap<string, Who>;
  zone: string;
  onBack?: () => void;
  onMute?: (muted: boolean) => void;
};
/**
 * The open conversation, and the thread open beside it (2B, Task 1; canvas board Main): where there isn't room for
 * both, the thread lies over it. Closing the thread puts the keyboard back where it was opened from.
 */
export function Conversation({
  thread,
  onThread,
  ...p
}: Props & {
  /** The message whose thread is open. */
  thread: number | null;
  onThread: (root: number | null) => void;
}) {
  const from = useRef<HTMLElement | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const can = useMentionable(p.conv.id);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const measure = () => setNarrow(el.clientWidth > 0 && el.clientWidth < BESIDE);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  const open = useCallback(
    (m: Shown) => {
      from.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      onThread(m.threadRoot ?? m.id);
    },
    [onThread],
  );
  const close = useCallback(() => {
    onThread(null);
    // Once the conversation is back on screen.
    requestAnimationFrame(() => {
      if (from.current?.isConnected) from.current.focus();
      else area.current?.querySelector<HTMLElement>("[role=log]")?.focus();
    });
  }, [onThread]);
  return (
    <div ref={area} className={s.cwrap} data-narrow={narrow || undefined}>
      <Talk {...p} can={can} onThread={open} covered={narrow && thread !== null} />
      {thread !== null && <Thread key={thread} {...p} can={can} root={thread} onClose={close} />}
    </div>
  );
}

/** Whom one may name in a conversation, and the teams' names: read once for it and its threads. */
function useMentionable(id: string): Mentionable | null {
  const [can, setCan] = useState<Mentionable | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      timer = undefined;
      void chatClient.mentionable(id).then((r) => {
        if (live && r.ok && Array.isArray(r.data?.teams)) setCan(r.data);
      });
    };
    ask();
    const off = subscribeChat((e) => {
      // Each tab at a moment of its own: everyone in it hears at once.
      if (e.c === id && (e.e === "members" || e.e === "changed"))
        timer ??= setTimeout(ask, 1000 + Math.floor(Math.random() * Math.max(2000, e.w ?? 0)));
    });
    return () => {
      live = false;
      clearTimeout(timer);
      off();
    };
  }, [id]);
  return can;
}

/** One thread: its first message, the replies to it, and a box to answer in. */
function Thread({
  root,
  onClose,
  conv,
  ...p
}: Props & { root: number; onClose: () => void; can: Mentionable | null }) {
  const el = useRef<HTMLElement>(null);
  useEffect(() => {
    // With a keyboard, ready to answer; on a touch screen no keyboard rises over what's to be read.
    const to = window.matchMedia("(hover: none)").matches
      ? el.current
      : (el.current?.querySelector<HTMLElement>("textarea") ?? el.current);
    to?.focus();
  }, []);
  return (
    <aside
      ref={el}
      className={s.thr}
      aria-label={`Thread in ${conv.kind === "channel" ? "#" : ""}${convName(conv)}`}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
        // The thread alone closes, not what it's in (a lead's drawer).
        e.stopPropagation();
        onClose();
      }}
    >
      <Talk conv={conv} {...p} root={root} onClose={onClose} />
    </aside>
  );
}

/** A conversation's messages and the box to write in, or a thread's. */
function Talk({
  conv,
  me,
  people,
  zone,
  onBack,
  onMute,
  root = null,
  onThread,
  onClose,
  covered = false,
  can,
}: Props & {
  can: Mentionable | null;
  root?: number | null;
  /** A thread lies over it: nothing in it is being looked at. */
  covered?: boolean;
  onThread?: (m: Shown) => void;
  onClose?: () => void;
}) {
  const { id } = conv;
  const inThread = root !== null;
  const box = root === null ? id : threadKey(root);
  const [also, setAlso] = useState(false);
  const [typing, setTyping] = useState<Record<string, number>>({});
  const [replying, setReplying] = useState<Shown | null>(null);
  const [editing, setEditing] = useState<Shown | null>(null);
  const [jump, setJump] = useState(false);
  const pending = usePending(box);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  /** How far from the bottom before older ones went in above, to stay where they were reading. */
  const keep = useRef<number | null>(null);
  const {
    msgs,
    older,
    loadingOlder,
    members,
    readAt,
    following,
    setFollowing,
    said,
    setSaid,
    seen,
    change,
    recheck,
    list,
    PAGES,
    loadOlder: olderPage,
  } = useMessages(conv, me, atBottom, root, covered);

  const whoOf = useCallback(
    (u: string | null): Who => (u === null ? { name: "LUME" } : (people.get(u) ?? { name: "Someone" })),
    [people],
  );
  const nameOf = useCallback(
    (t: "person" | "team", who: string) =>
      (t === "person" ? people.get(who)?.name : can?.teams.find((x) => x.id === who)?.name) ?? null,
    [people, can],
  );
  const loadOlder = useCallback(
    () =>
      olderPage(() => {
        const el = scroller.current;
        if (el) keep.current = el.scrollHeight - el.scrollTop;
      }),
    [olderPage],
  );

  // Live: someone types; a message being answered or changed is deleted.
  useEffect(
    () =>
      subscribeChat((e) => {
        if (e.c !== id) return;
        if (e.e === "typing" && !inThread && e.u && e.u !== me) {
          const until = Date.now() + CHAT_LIMITS.typingShowsMs;
          setTyping((t) => ({ ...t, [e.u!]: until }));
        } else if (e.e === "message" && e.u) {
          // Whoever wrote it has stopped typing.
          setTyping((t) => ({ ...t, [e.u!]: 0 }));
        } else if (e.e === "deleted" && e.m) {
          setReplying((r) => (r?.id === e.m ? null : r));
          setEditing((r) => (r?.id === e.m ? null : r));
        }
      }),
    [id, me, inThread],
  );

  // Typing goes 5 s after the last.
  const [now, setNow] = useState(() => Date.now());
  /** Someone's time was up: never `now` itself, which each pass would move on, and so run the next. */
  const [upto, setUpto] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const next = Object.values(typing).filter((t) => t > t0);
    setNow(t0);
    if (!next.length) return;
    const t = setTimeout(() => setUpto((n) => n + 1), Math.min(...next) - t0 + 10);
    return () => clearTimeout(t);
  }, [typing, upto]);
  const typers = Object.entries(typing)
    .filter(([u, until]) => until > now && u !== me)
    .map(([u]) => whoOf(u).name);

  // Messages, then those being sent (a landed one is never shown twice), as runs of bubbles.
  const shown: Shown[] = useMemo(() => {
    const landed = new Set((msgs ?? []).map((m) => m.clientId).filter(Boolean));
    const all: (MessageView & { pending?: "sending" | "failed"; why?: string })[] = [
      ...(msgs ?? []),
      ...pending.filter((p) => !landed.has(p.clientId)),
    ];
    const runs = runsOf(all, me, zone);
    // Under the first message's line, the replies begin again with who says them.
    if (runs[0]?.id === root && runs[1]) runs[1] = { ...runs[1], head: true };
    return runs;
  }, [msgs, pending, me, zone, root]);
  const replies = inThread ? (msgs ?? []).filter((m) => m.id !== root && !m.deletedAt).length : 0;

  const firstNew =
    readAt === null
      ? null
      : (msgs?.find((m) => m.id > readAt && m.authorId !== me && !m.deletedAt)?.id ?? null);
  /** The New line may be further up than what's loaded: it isn't drawn at the top of a page it doesn't belong to. */
  const newIsAbove = older && firstNew !== null && (msgs?.[0]?.id ?? 0) > (readAt ?? 0);

  const toFirstNew = async () => {
    setJump(false);
    for (let i = 0; i < PAGES; i++) {
      const first = list.current?.[0]?.id ?? 0;
      if (readAt === null || first <= readAt || !(await loadOlder())) break;
    }
    atBottom.current = false;
    requestAnimationFrame(() =>
      scroller.current?.querySelector("[data-new-line]")?.scrollIntoView({ block: "center" }),
    );
  };

  // Kept at the bottom when it was there, where they were reading when older ones went in above, and otherwise alone.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keep.current !== null) {
      el.scrollTop = el.scrollHeight - keep.current;
      keep.current = null;
    } else if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [shown, typers.length]);
  // Something further up is unread: a way there, until it's been seen or left behind.
  const opened = useRef(false);
  useEffect(() => {
    if (msgs === null || opened.current) return;
    opened.current = true;
    const el = scroller.current;
    const line = el?.querySelector<HTMLElement>("[data-new-line]");
    if (newIsAbove || (el && line && line.offsetTop < el.scrollTop)) setJump(true);
  }, [msgs, newIsAbove]);
  const others = members.filter((x) => x.userId !== me);
  const onSend = (text: string, files: FileView[]) => {
    atBottom.current = true;
    setJump(false);
    const replyTo = replying ? { id: replying.id, authorId: replying.authorId, body: replying.body } : null;
    const where = { conv: id, ...(root === null ? {} : { thread: { root, also } }) };
    sendInto(where, me, { body: text.trim() || null, replyTo, files });
    // Answering follows it.
    if (inThread) setFollowing(true);
    setAlso(false);
    setReplying(null);
    setSaid(null);
  };
  const tried = useCallback(
    (mid: number, r: { ok: boolean; message?: string }) => {
      if (r.ok) return;
      setSaid(r.message ?? null);
      // As it is after all.
      recheck(mid);
    },
    [recheck, setSaid],
  );
  const onReact = useCallback(
    (m: Shown, emoji: string, on: boolean) => {
      setSaid(null);
      const answered = chatClient.react(m.id, emoji, on);
      change(
        m.id,
        (x) => {
          const had = x.reactions.find((r) => r.emoji === emoji);
          // Already so (kept over a page that has it): the same again, never counted twice.
          if (!!had?.mine === on) return x;
          const n = (had?.count ?? 0) + (on ? 1 : -1);
          const rest = x.reactions.filter((r) => r.emoji !== emoji);
          const at = had ? x.reactions.indexOf(had) : rest.length;
          return {
            ...x,
            reactions:
              n > 0 ? [...rest.slice(0, at), { emoji, count: n, mine: on }, ...rest.slice(at)] : rest,
          };
        },
        answered,
      );
      void answered.then((r) => tried(m.id, r));
    },
    [change, tried, setSaid],
  );
  const onReply = useCallback((m: Shown) => {
    setEditing(null);
    setReplying(m);
  }, []);
  const onEdit = useCallback((m: Shown) => {
    setReplying(null);
    setEditing(m);
  }, []);
  const onDelete = useCallback(
    (m: Shown) => {
      setSaid(null);
      const answered = chatClient.remove(m.id);
      const at = new Date().toISOString();
      change(
        m.id,
        (x) => ({ ...x, body: null, files: [], reactions: [], replyTo: null, deletedAt: at }),
        answered,
      );
      setReplying((r) => (r?.id === m.id ? null : r));
      setEditing((r) => (r?.id === m.id ? null : r));
      void answered.then((r) => tried(m.id, r));
    },
    [change, tried, setSaid],
  );
  const onRetry = useCallback((m: Shown) => m.clientId && retry(box, m.clientId), [box]);
  const onDiscard = useCallback((m: Shown) => m.clientId && discard(box, m.clientId), [box]);
  /** Saved, or why not (the words stay in the box). */
  const onSave = async (mid: number, text: string): Promise<boolean> => {
    setSaid(null);
    const r = await chatClient.edit(mid, text);
    if (!r.ok) {
      setSaid(r.message);
      return false;
    }
    setEditing(null);
    // Its words alone: whatever else a page says of it since (deleted elsewhere, a reaction) stands.
    const saved = r.data;
    change(
      mid,
      (x) => ({
        ...x,
        body: saved.body,
        editedAt: saved.editedAt,
        ...(saved.notTold ? { notTold: saved.notTold } : {}),
      }),
      Promise.resolve({ ok: true }),
    );
    return true;
  };

  const title = convName(conv);
  const named = conv.kind === "channel" ? `#${title}` : title;
  const label = inThread ? "Reply in the thread" : `Message ${named}`;
  const follow = async () => {
    const on = !following;
    setFollowing(on);
    const r = await chatClient.followThread(root!, on);
    if (r.ok) return;
    setFollowing(!on);
    setSaid(r.message);
  };
  let lastDay = "";
  return (
    <section className={s.conv} inert={covered || undefined} {...(inThread ? {} : { "aria-label": named })}>
      {inThread ? (
        <header className={s.chead}>
          <h2 className={s.ctitle}>Thread</h2>
          <span className={s.cdesc}>{named}</span>
          {following !== null && (
            <button
              type="button"
              className={s.tbtn}
              aria-pressed={following}
              onClick={() => void follow()}
              title={
                following
                  ? "New replies here are counted in Chat's number"
                  : "Count new replies here in Chat's number"
              }
            >
              {following ? "Following" : "Follow"}
            </button>
          )}
          <button type="button" className={s.tbtn} aria-label="Close the thread" onClick={onClose}>
            ×
          </button>
        </header>
      ) : (
        <header className={s.chead}>
          {onBack && (
            <button type="button" className={`${s.tbtn} ${s.back}`} onClick={onBack}>
              Back
            </button>
          )}
          <h2 className={s.ctitle}>{conv.kind === "channel" ? `# ${title}` : title}</h2>
          <span className={s.cdesc}>{conv.topic ?? ""}</span>
          {onMute && (
            <button
              type="button"
              className={s.tbtn}
              aria-pressed={conv.muted}
              onClick={() => onMute(!conv.muted)}
              title={
                conv.muted
                  ? "Its messages aren't counted in Chat's number"
                  : "Leave its messages out of Chat's number"
              }
            >
              {conv.muted ? "Muted" : "Mute"}
            </button>
          )}
        </header>
      )}
      <div className={s.mwrap}>
        <div
          ref={scroller}
          className={s.mscroll}
          role="log"
          aria-live="polite"
          aria-label={inThread ? "The thread's messages" : "Messages"}
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR;
            if (atBottom.current) seen();
            if (el.scrollTop < NEAR * 2 && older && !loadingOlder) void loadOlder();
          }}
        >
          {msgs === null && <p className={s.cnone}>Loading…</p>}
          {msgs !== null && older && (
            <p className={s.older}>
              <button
                type="button"
                className={s.tbtn}
                disabled={loadingOlder}
                onClick={() => void loadOlder()}
              >
                {loadingOlder ? "Loading…" : "Earlier messages"}
              </button>
            </p>
          )}
          {msgs !== null && shown.length === 0 && (
            <div className={s.empty}>
              <p>
                {conv.kind === "lead"
                  ? "Nothing here yet. Only people who can see this lead read what's written here."
                  : "Nothing here yet. Say hello."}
              </p>
            </div>
          )}
          {shown.map((m) => {
            const day = dayKey(m.createdAt, zone);
            const showDay = day !== lastDay;
            lastDay = day;
            const tick =
              !inThread && m.side === "mine" && conv.kind === "direct" && !m.pending && !m.deletedAt
                ? ticksOf(m.id, others)
                : null;
            return (
              // One being sent keeps its place as it lands.
              <div key={m.clientId ?? m.id}>
                {showDay && (
                  <div className={s.dayline}>
                    <span>{dayWords(m.createdAt, zone)}</span>
                  </div>
                )}
                {firstNew === m.id && !newIsAbove && (
                  <div className={s.newline} data-new-line="">
                    <span>New</span>
                  </div>
                )}
                <Bubble
                  m={m}
                  who={whoOf(m.authorId)}
                  showName={m.head && m.side === "in" && conv.kind !== "direct"}
                  time={timeOf(m.createdAt, zone)}
                  tick={tick}
                  quoteWho={m.replyTo ? whoOf(m.replyTo.authorId).name : null}
                  onReact={onReact}
                  onReply={onReply}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onRetry={onRetry}
                  onDiscard={onDiscard}
                  nameOf={nameOf}
                  me={me}
                  {...(onThread ? { onThread, faceOf: whoOf } : {})}
                  lastReply={m.thread ? lastWords(m.thread.lastAt, zone) : null}
                />
                {m.id === root && replies > 0 && (
                  <div className={s.rdiv}>
                    <span>{repliesWords(replies)}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {jump && (
          <button type="button" className={s.jump} onClick={() => void toFirstNew()}>
            Jump to first unread
          </button>
        )}
      </div>
      <div className={s.typing} aria-live="polite">
        {typingWords(typers)}
      </div>
      {said && (
        <p className={s.cnone} role="alert">
          {said}
        </p>
      )}
      <Composer
        label={label}
        draftKey={box}
        nameOf={nameOf}
        optionsFor={(words) => (can ? optionsFor(words, can, people, me) : [])}
        replying={
          replying ? { who: whoOf(replying.authorId).name, text: plainOf(replying.body ?? "", nameOf) } : null
        }
        editing={
          editing ? { id: editing.id, text: editing.body ?? "", hasFiles: editing.files.length > 0 } : null
        }
        onCancel={() => {
          setReplying(null);
          setEditing(null);
        }}
        onSend={onSend}
        onSave={onSave}
        onTyping={() => {
          // Said to the conversation alone: in a thread it would show beside the wrong messages.
          if (!inThread) void chatClient.typing(id);
        }}
        {...(inThread
          ? {
              also: {
                label: conv.kind === "channel" ? `Also send to ${named}` : "Also send to the conversation",
                on: also,
                set: setAlso,
              },
            }
          : {})}
      />
    </section>
  );
}
