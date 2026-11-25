"use client";
import { CHAT_LIMITS, runsOf, ticksOf, typingWords } from "@lume/core/shared";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { chatClient, type ConvRow, type FileView, type MessageView } from "@/lib/chat/client";
import { discard, retry, sendInto, usePending } from "@/lib/chat/outbox";
import { subscribeChat } from "@/lib/notifications/stream";
import { Bubble, type Shown, type Who } from "./Bubble";
import { Composer } from "./Composer";
import { convName } from "./ConvList";
import { useMessages } from "./useMessages";
import s from "./chat.module.css";

const dayKey = (iso: string, zone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
function dayWords(iso: string, zone: string, now = new Date()): string {
  const k = dayKey(iso, zone);
  if (k === dayKey(now.toISOString(), zone)) return "Today";
  if (k === dayKey(new Date(now.getTime() - 86_400_000).toISOString(), zone)) return "Yesterday";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: zone,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(iso));
}
const timeOf = (iso: string, zone: string) =>
  new Intl.DateTimeFormat("en-IN", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(
    new Date(iso),
  );
const NEAR = 40;

/** The open conversation (approved canvas, boards Main and ChatDark; plan Task 7). */
export function Conversation({
  conv,
  me,
  people,
  zone,
  onBack,
  onMute,
}: {
  conv: ConvRow;
  me: string;
  people: ReadonlyMap<string, Who>;
  zone: string;
  onBack?: () => void;
  onMute?: (muted: boolean) => void;
}) {
  const { id } = conv;
  const [typing, setTyping] = useState<Record<string, number>>({});
  const [replying, setReplying] = useState<Shown | null>(null);
  const [editing, setEditing] = useState<Shown | null>(null);
  const [jump, setJump] = useState(false);
  const pending = usePending(id);
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
    said,
    setSaid,
    seen,
    change,
    recheck,
    list,
    PAGES,
    loadOlder: olderPage,
  } = useMessages(conv, me, atBottom);

  const whoOf = useCallback(
    (u: string | null): Who => (u === null ? { name: "LUME" } : (people.get(u) ?? { name: "Someone" })),
    [people],
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
        if (e.e === "typing" && e.u && e.u !== me) {
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
    [id, me],
  );

  // Typing goes 5 s after the last.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t0 = Date.now();
    const next = Object.values(typing).filter((t) => t > t0);
    setNow(t0);
    if (!next.length) return;
    const t = setTimeout(() => setNow(Date.now()), Math.min(...next) - t0 + 10);
    return () => clearTimeout(t);
  }, [typing, now]);
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
    return runsOf(all, me, zone);
  }, [msgs, pending, me, zone]);

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
    sendInto(id, me, { body: text.trim() || null, replyTo, files });
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
      change(m.id, (x) => {
        const had = x.reactions.find((r) => r.emoji === emoji);
        const n = (had?.count ?? 0) + (on ? 1 : -1);
        const rest = x.reactions.filter((r) => r.emoji !== emoji);
        const at = had ? x.reactions.indexOf(had) : rest.length;
        return {
          ...x,
          reactions: n > 0 ? [...rest.slice(0, at), { emoji, count: n, mine: on }, ...rest.slice(at)] : rest,
        };
      });
      void chatClient.react(m.id, emoji, on).then((r) => tried(m.id, r));
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
      change(m.id, (x) => ({
        ...x,
        body: null,
        files: [],
        reactions: [],
        replyTo: null,
        deletedAt: new Date().toISOString(),
      }));
      setReplying((r) => (r?.id === m.id ? null : r));
      setEditing((r) => (r?.id === m.id ? null : r));
      void chatClient.remove(m.id).then((r) => tried(m.id, r));
    },
    [change, tried, setSaid],
  );
  const onRetry = useCallback((m: Shown) => m.clientId && retry(id, m.clientId), [id]);
  const onDiscard = useCallback((m: Shown) => m.clientId && discard(id, m.clientId), [id]);
  /** Saved, or why not (the words stay in the box). */
  const onSave = async (mid: number, text: string): Promise<boolean> => {
    setSaid(null);
    const r = await chatClient.edit(mid, text);
    if (!r.ok) {
      setSaid(r.message);
      return false;
    }
    setEditing(null);
    change(mid, () => r.data);
    return true;
  };

  const title = convName(conv);
  const label = conv.kind === "channel" ? `Message #${title}` : `Message ${title}`;
  let lastDay = "";
  return (
    <section className={s.conv} aria-label={conv.kind === "channel" ? `#${title}` : title}>
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
      <div className={s.mwrap}>
        <div
          ref={scroller}
          className={s.mscroll}
          role="log"
          aria-live="polite"
          aria-label="Messages"
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
              m.side === "mine" && conv.kind === "direct" && !m.pending && !m.deletedAt
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
                />
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
        draftKey={id}
        replying={replying ? { who: whoOf(replying.authorId).name, text: replying.body ?? "" } : null}
        editing={
          editing ? { id: editing.id, text: editing.body ?? "", hasFiles: editing.files.length > 0 } : null
        }
        onCancel={() => {
          setReplying(null);
          setEditing(null);
        }}
        onSend={onSend}
        onSave={onSave}
        onTyping={() => void chatClient.typing(id)}
      />
    </section>
  );
}
