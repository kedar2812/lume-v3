"use client";
import { plainOf, repliesWords } from "@lume/core/shared";
import { memo, useState } from "react";
import { Avatar } from "@/components/ui/Avatar";
import type { MessageView } from "@/lib/chat/client";
import { Words, type NameOf } from "./Words";
import s from "./chat.module.css";

export type Who = { name: string; color?: string; photo?: string; active?: boolean };
export type Shown = MessageView & {
  side: "in" | "mine";
  head: boolean;
  /** Sent from this tab and not answered yet; `failed` when it couldn't go. */
  pending?: "sending" | "failed";
  /** Why it couldn't go, in the server's words. */
  why?: string;
};

const QUICK = ["👍", "❤️", "😂", "🎉", "🙏", "🔥"];

/**
 * One message (owner, 2026-11-24): a bubble on its sender's photo, theirs on the left in grey and yours on the right in
 * blue; the first of a run carries the photo (and, where there are several people, the name). The time and, on yours,
 * the ticks sit in the bubble's corner; reactions on its lower edge.
 */
export const Bubble = memo(function Bubble({
  m,
  who,
  showName,
  time,
  tick,
  quoteWho,
  onReact,
  onReply,
  onEdit,
  onDelete,
  onRetry,
  onDiscard,
  onThread,
  lastReply,
  faceOf,
  nameOf,
  me,
}: {
  m: Shown;
  who: Who;
  showName: boolean;
  time: string;
  tick: "sent" | "delivered" | "seen" | null;
  quoteWho: string | null;
  onReact: (m: Shown, emoji: string, on: boolean) => void;
  onReply: (m: Shown) => void;
  onEdit: (m: Shown) => void;
  onDelete: (m: Shown) => void;
  onRetry: (m: Shown) => void;
  onDiscard: (m: Shown) => void;
  /** Opens the thread on this message (or the one it was said in); none inside a thread itself. */
  onThread?: (m: Shown) => void;
  /** When its thread was last answered, in words; its people, by id. */
  lastReply?: string | null;
  faceOf?: (id: string) => Who;
  nameOf: NameOf;
  me: string;
}) {
  const gone = m.deletedAt !== null;
  /** On a touch screen, a tap on the bubble brings what can be done with it. */
  const [tools, setTools] = useState(false);
  /** Deleting can't be undone: asked once more, on the same button. */
  const [sure, setSure] = useState(false);
  const [near, setNear] = useState(false);
  const stop = near ? 0 : -1;
  const done = () => {
    setTools(false);
    setSure(false);
  };
  const meta = (
    <span className={`${s.bmeta}${m.body ? ` ${s.float}` : ""}`}>
      {m.editedAt && !gone && <span>edited</span>}
      <span>{time}</span>
      {tick && (
        <span className={s.ticks} data-tick={tick} role="img" aria-label={TICK_WORDS[tick]}>
          <svg
            viewBox="0 0 24 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="m2 8.5 4 4L13 4" />
            <path className={s.t2} d="m10 12.5 1 0L19 4" />
          </svg>
        </span>
      )}
    </span>
  );
  return (
    <div
      className={s.msg}
      data-side={m.side}
      data-head={m.head || undefined}
      data-pending={m.pending || undefined}
      data-tools={tools || undefined}
      // One stop for each message; its buttons once it's reached.
      tabIndex={gone || m.pending ? -1 : 0}
      onFocus={() => setNear(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setNear(false);
      }}
      onMouseLeave={done}
      aria-label={`${who.name}, ${time}`}
      role="group"
    >
      <span className={s.mav}>{m.head && <Avatar size={32} {...who} />}</span>
      <div className={s.bcol}>
        <div
          className={s.bub}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("a, button") || !window.matchMedia("(hover: none)").matches)
              return;
            setTools((t) => !t);
            setSure(false);
          }}
        >
          {showName && (
            <span className={s.bname} style={who.color ? { color: who.color } : undefined}>
              {who.name}
            </span>
          )}
          {onThread && m.threadRoot !== null && (
            <button type="button" className={s.inthread} onClick={() => onThread(m)}>
              Replied in a thread
            </button>
          )}
          {!gone && m.replyTo && (
            <div className={s.quote}>
              <b>{quoteWho ?? "Someone"}</b>
              <span>
                {m.replyTo.body === null ? "This message was deleted" : plainOf(m.replyTo.body, nameOf)}
              </span>
            </div>
          )}
          {!gone &&
            m.files.map((f) =>
              f.kind === "image" ? (
                <a key={f.id} href={f.url} target="_blank" rel="noreferrer">
                  <img className={s.photo} src={f.url} alt={f.name} loading="lazy" />
                </a>
              ) : (
                <a key={f.id} className={s.file} href={f.url} target="_blank" rel="noreferrer">
                  <span>{f.name}</span>
                </a>
              ),
            )}
          {gone ? (
            <div className={`${s.mtext} ${s.gone}`}>
              This message was deleted
              {meta}
            </div>
          ) : m.body ? (
            <div className={s.mtext}>
              <Words body={m.body} nameOf={nameOf} me={me} />
              {meta}
            </div>
          ) : (
            meta
          )}
        </div>
        {!gone && m.reactions.length > 0 && (
          <div className={s.reacts}>
            {m.reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                className={s.react}
                aria-pressed={r.mine}
                aria-label={`${r.emoji} ${r.count}${r.mine ? ", yours" : ""}`}
                onClick={() => onReact(m, r.emoji, !r.mine)}
              >
                <span aria-hidden>{r.emoji}</span>
                <b>{r.count}</b>
              </button>
            ))}
          </div>
        )}
        {onThread && m.thread && (
          <button type="button" className={s.tlink} onClick={() => onThread(m)}>
            <span className={s.tfaces} aria-hidden>
              {m.thread.faces.map((f) => (
                <Avatar key={f} size={18} {...(faceOf?.(f) ?? { name: "Someone" })} />
              ))}
            </span>
            <b>{repliesWords(m.thread.replies)}</b>
            {lastReply && <span className={s.tlast}>Last reply {lastReply}</span>}
          </button>
        )}
        {m.notTold && m.notTold.length > 0 && !gone && (
          <span className={s.why}>
            Not told, as they can&apos;t read this:{" "}
            {m.notTold.map((p) => nameOf("person", p) ?? "someone").join(", ")}
          </span>
        )}
        {m.pending === "failed" && (
          <span className={s.failed}>
            <button type="button" className={s.retry} onClick={() => onRetry(m)}>
              Couldn&apos;t send. Try again
            </button>
            {m.why && <span className={s.why}>{m.why}</span>}
            <button type="button" className={s.tbtn} onClick={() => onDiscard(m)}>
              Discard
            </button>
          </span>
        )}
      </div>
      {!gone && !m.pending && (
        <span className={s.tools}>
          {QUICK.map((e) => (
            <button
              key={e}
              type="button"
              tabIndex={stop}
              className={s.tbtn}
              aria-label={`React ${e}`}
              onClick={() => {
                done();
                onReact(m, e, !m.reactions.some((r) => r.emoji === e && r.mine));
              }}
            >
              {e}
            </button>
          ))}
          <button
            type="button"
            tabIndex={stop}
            className={s.tbtn}
            onClick={() => {
              done();
              onReply(m);
            }}
          >
            Reply
          </button>
          {onThread && (
            <button
              type="button"
              tabIndex={stop}
              className={s.tbtn}
              onClick={() => {
                done();
                onThread(m);
              }}
            >
              Thread
            </button>
          )}
          {m.side === "mine" && (
            <>
              <button
                type="button"
                tabIndex={stop}
                className={s.tbtn}
                onClick={() => {
                  done();
                  onEdit(m);
                }}
              >
                Edit
              </button>
              <button
                type="button"
                tabIndex={stop}
                className={`${s.tbtn} ${s.keep}`}
                data-sure={sure || undefined}
                onClick={() => {
                  if (!sure) return setSure(true);
                  done();
                  onDelete(m);
                }}
              >
                <span>{sure ? "Delete for everyone?" : "Delete"}</span>
                {/* Room for the longer ask from the start: asking again never moves the button from under the pointer. */}
                <span className={s.room} aria-hidden>
                  Delete for everyone?
                </span>
              </button>
            </>
          )}
        </span>
      )}
    </div>
  );
});

const TICK_WORDS = { sent: "Sent", delivered: "Delivered", seen: "Seen" } as const;
