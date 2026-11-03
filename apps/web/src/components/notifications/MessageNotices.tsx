"use client";
import { AnimatePresence, motion, useReducedMotion, type PanInfo } from "motion/react";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { WhatsAppIcon } from "@/components/ui/WhatsAppIcon";
import { timeOf } from "@/lib/dates";
import { SPRINGS, toMotion } from "@/lib/motion";
import { useWhatsApp, type WhatsAppEvent } from "@/lib/notifications/stream";
import { whatsappClient } from "@/lib/whatsapp/client";
import { isChatOpen, onChatOpened } from "@/lib/whatsapp/open-chats";
import s from "./MessageNotices.module.css";

const NOUN = {
  image: "Photo",
  sticker: "Sticker",
  video: "Video",
  audio: "Voice note",
  document: "Document",
} as const;
/** Long enough to read two lines; a pointer or focus on it holds it. */
export const NOTICE_MS = 8000;
const MAX = 3;
/** A flick this fast (px/s), or a drag this far, sends it off to the side. */
const FLICK = 500;
const FAR = 90;

type Notice = { leadId: string; name: string; words: string; at: string; count: number };

/**
 * A notice in the corner for each WhatsApp message a person's own lead sends (2026-11-01, owner): who, what they wrote and
 * when; pressing it opens their chat. One per lead (a second message updates it), at most three, none for a chat already
 * on screen (and one already up goes when its chat opens), none when the person switched reply alerts off. Never a phone number. Silent: LUME's sounds are for
 * achievements.
 */
export function MessageNotices({
  userId,
  tz,
  repliesOn,
  onOpen,
}: {
  userId: string;
  tz: string;
  repliesOn: boolean;
  onOpen(leadId: string): void;
}) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const reduce = useReducedMotion();

  const dismiss = useCallback((leadId: string) => {
    clearTimeout(timers.current.get(leadId));
    timers.current.delete(leadId);
    setNotices((xs) => xs.filter((x) => x.leadId !== leadId));
  }, []);
  const arm = useCallback(
    (leadId: string, ms = NOTICE_MS) => {
      clearTimeout(timers.current.get(leadId));
      timers.current.set(
        leadId,
        setTimeout(() => dismiss(leadId), ms),
      );
    },
    [dismiss],
  );
  const hold = (leadId: string) => clearTimeout(timers.current.get(leadId));
  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);
  // Their chat opened another way (the drawer, LUME AI): the notice has nothing left to say, and on a phone it would sit
  // over the chat's own header.
  useEffect(() => onChatOpened(dismiss), [dismiss]);

  useWhatsApp((e: WhatsAppEvent) => {
    if (e.kind !== "in" || e.owner !== userId || !repliesOn || isChatOpen(e.lead)) return;
    void whatsappClient.latest(e.lead).then((r) => {
      // Gone from view meanwhile, or the chat opened while it loaded: nothing to say.
      if (!r.ok || !r.data.message || isChatOpen(e.lead)) return;
      const m = r.data.message;
      const words = m.text?.trim() || (m.media ? NOUN[m.media.kind] : "Sent a message");
      const name = r.data.name?.trim() || "A lead";
      setNotices((xs) => {
        const was = xs.find((x) => x.leadId === e.lead);
        // The same message told twice (a stream replay) is one.
        if (was && was.at === m.at) return xs;
        const next: Notice = { leadId: e.lead, name, words, at: m.at, count: (was?.count ?? 0) + 1 };
        return [next, ...xs.filter((x) => x.leadId !== e.lead)].slice(0, MAX);
      });
      arm(e.lead);
    });
  });
  // Notices pushed out by a fourth one go with their timers.
  useEffect(() => {
    for (const id of timers.current.keys())
      if (!notices.some((n) => n.leadId === id)) {
        clearTimeout(timers.current.get(id));
        timers.current.delete(id);
      }
  }, [notices]);

  const open = (leadId: string) => {
    dismiss(leadId);
    onOpen(leadId);
  };
  const swiped = (leadId: string, info: PanInfo) => {
    if (info.offset.x > FAR || info.velocity.x > FLICK) dismiss(leadId);
  };

  return (
    <section className={s.region} aria-label="Messages from your leads">
      <AnimatePresence initial={false}>
        {notices.map((n) => (
          <motion.div
            key={n.leadId}
            layout={!reduce}
            className={s.notice}
            initial={reduce ? { opacity: 0 } : { opacity: 0, x: 48, scale: 0.96, filter: "blur(6px)" }}
            animate={{ opacity: 1, x: 0, scale: 1, filter: "blur(0px)" }}
            exit={
              reduce ? { opacity: 0 } : { opacity: 0, x: 120, transition: { duration: 0.22, ease: "easeIn" } }
            }
            transition={reduce ? { duration: 0.18 } : toMotion(SPRINGS.drawer)}
            drag={reduce ? false : "x"}
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={{ left: 0.08, right: 0.9 }}
            onDragEnd={(_, info) => swiped(n.leadId, info)}
            onMouseEnter={() => hold(n.leadId)}
            onMouseLeave={() => arm(n.leadId, 2500)}
            onFocus={() => hold(n.leadId)}
            onBlur={() => arm(n.leadId, 2500)}
          >
            <button
              type="button"
              className={s.open}
              onClick={() => open(n.leadId)}
              aria-label={`${n.name} on WhatsApp: ${n.words}. Open the chat`}
            >
              <span className={s.who} aria-hidden>
                <Avatar name={n.name} size={38} />
                <span className={s.badge}>
                  <WhatsAppIcon size={16} />
                </span>
              </span>
              <span className={s.text} aria-hidden>
                <span className={s.top}>
                  <b className={s.name}>{n.name}</b>
                  <span className={s.when}>{timeOf(new Date(n.at), tz)}</span>
                </span>
                <span className={s.words}>{n.words}</span>
                {n.count > 1 && <span className={s.more}>{n.count} new messages</span>}
              </span>
            </button>
            <button
              type="button"
              className={s.close}
              aria-label={`Dismiss ${n.name}'s message`}
              onClick={() => dismiss(n.leadId)}
            >
              <X size={13} aria-hidden />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </section>
  );
}

/** Where pressing a notice goes: this lead's chat on Leads, keeping the filters already there. */
export function chatHref(
  leadId: string,
  here: { pathname: string; search: string },
  now = Date.now(),
): string {
  const q = new URLSearchParams(here.pathname === "/leads" ? here.search : "");
  q.set("lead", leadId);
  q.set("chat", String(now));
  return `/leads?${q.toString()}`;
}
