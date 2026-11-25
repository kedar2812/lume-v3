"use client";
import { plainOf, repliesWords } from "@lume/core/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { chatClient, type ThreadRow } from "@/lib/chat/client";
import { subscribeChat } from "@/lib/notifications/stream";
import type { Who } from "./Bubble";
import { convName } from "./ConvList";
import { lastWords } from "./when";
import s from "./chat.module.css";

/** A reply in one of them is shown within this long, however many come at once; seldomer where many listen. */
const SOON_MS = 1500;
/** After a read that failed, again this long after (tests shorten it). */
export const threadsTuning = { againMs: 15_000 };

/** The threads a person follows, the newest reply first (2B, Task 1): each opens beside its conversation. */
export function Threads({
  people,
  zone,
  onOpen,
  onBack,
  me,
}: {
  me: string;
  people: ReadonlyMap<string, Who>;
  zone: string;
  onOpen: (conversation: string, root: number) => void;
  onBack: () => void;
}) {
  const [rows, setRows] = useState<ThreadRow[] | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const live = useRef(true);
  const missed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const read = useCallback(async () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const r = await chatClient.threads();
    if (!live.current) return;
    if (r.ok) {
      setRows(r.data.threads);
      setSaid(null);
    } else {
      setSaid(r.message);
      timer.current = setTimeout(() => void read(), threadsTuning.againMs);
    }
  }, []);
  useEffect(() => {
    live.current = true;
    void read();
    const later = (ms: number) => {
      timer.current ??= setTimeout(() => {
        timer.current = undefined;
        // Nobody is looking: when they are.
        if (document.visibilityState === "hidden") missed.current = true;
        else void read();
      }, ms);
    };
    const off = subscribeChat((e) => {
      // A reply counts where it's followed; a thread read, left or deleted from is theirs to see too.
      const theirs =
        e.c === "*" ||
        (e.e === "reply" ? e.f || e.u === me : e.t !== undefined) ||
        e.e === "members" ||
        e.e === "changed";
      const apart = Math.max(SOON_MS, 3 * (e.w ?? 0));
      if (theirs) later(apart + Math.floor(Math.random() * apart * 0.5));
    });
    const back = () => {
      if (document.visibilityState === "hidden" || !missed.current) return;
      missed.current = false;
      void read();
    };
    document.addEventListener("visibilitychange", back);
    return () => {
      live.current = false;
      clearTimeout(timer.current);
      off();
      document.removeEventListener("visibilitychange", back);
    };
  }, [read, me]);
  const whoOf = (u: string | null): Who =>
    u === null ? { name: "LUME" } : (people.get(u) ?? { name: "Someone" });
  return (
    <section className={s.conv} aria-label="Threads">
      <header className={s.chead}>
        <button type="button" className={`${s.tbtn} ${s.back}`} onClick={onBack}>
          Back
        </button>
        <h2 className={s.ctitle}>Threads</h2>
      </header>
      <div className={s.trows} tabIndex={0} role="region" aria-label="The threads you follow">
        {said && (
          <p className={s.cnone} role="alert">
            {said}
          </p>
        )}
        {rows === null && !said && <p className={s.cnone}>Loading…</p>}
        {rows?.length === 0 && (
          <div className={s.empty}>
            <p>Nothing here yet. The threads you start or answer are kept here.</p>
          </div>
        )}
        {rows?.map(({ root, conversation, unread }) => {
          const who = whoOf(root.authorId);
          const name =
            conversation.kind === "channel" ? `# ${convName(conversation)}` : convName(conversation);
          const words = root.deletedAt
            ? "This message was deleted"
            : root.body
              ? plainOf(root.body, (t, who) => (t === "person" ? (people.get(who)?.name ?? null) : null))
              : (root.files[0]?.name ?? "");
          return (
            <button
              key={root.id}
              type="button"
              className={s.trow}
              data-unread={unread > 0 || undefined}
              onClick={() => onOpen(conversation.id, root.id)}
            >
              <Avatar size={32} {...who} />
              <span className={s.trin}>
                <span className={s.trhead}>
                  <b>{who.name}</b>
                  <span className={s.trin2}>{name}</span>
                  {root.thread && <span className={s.trat}>{lastWords(root.thread.lastAt, zone)}</span>}
                </span>
                <span className={s.trwords}>{words}</span>
                <span className={s.trfoot}>
                  {root.thread ? repliesWords(root.thread.replies) : ""}
                  {unread > 0 && <span className={s.un}>{unread > 99 ? "99+" : unread} new</span>}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
