"use client";
import { bytesText } from "@lume/core/shared";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { addDays, dayKey, longDate, timeOf } from "@/lib/dates";
import { SPRINGS, toMotion } from "@/lib/motion";
import { mediaUrl, whatsappClient } from "@/lib/whatsapp/client";
import type { WaMediaInfo, WaThreadMessage } from "@/lib/whatsapp/types";
import { ReplyMeaning } from "./ReplyMeaning";
import s from "./whatsapp.module.css";

const first = (name: string) => name.trim().split(/\s+/)[0] || name;
const NOUN: Record<WaMediaInfo["kind"], string> = {
  image: "photo",
  audio: "voice note",
  video: "video",
  document: "document",
  sticker: "sticker",
};
/** "1.2 MB", "84 KB": the same words as everywhere else in LUME. */
export const sizeWords = (bytes: number | null): string | null => (bytes === null ? null : bytesText(bytes));
const typeWord = (mime: string, filename: string | null) =>
  mime === "application/pdf" ? "PDF" : (filename?.split(".").pop()?.toUpperCase() ?? "File");

/** While a file is on its way: looked at again this often, for this long (then the next open of the lead). */
const RECHECK_MS = 4_000;
const RECHECK_FOR_MS = 120_000;

/**
 * One file in a message: here, on its way, or said in words when it can't be shown (too large, past "keep files for",
 * gone from the disk, or waiting for a reason such as a full disk). A file on its way is looked at again until it's
 * here; one that won't load says so rather than showing a broken image.
 */
function MediaPart({ media, from }: { media: NonNullable<WaThreadMessage["media"]>; from: string }) {
  const [info, setInfo] = useState<WaMediaInfo | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const look = async () => {
      const r = await whatsappClient.mediaInfo(media.id);
      if (!live || !r.ok) return;
      setInfo(r.data);
      // On its way (no reason given to wait): look again shortly. A reason (a full disk) means minutes, not seconds.
      if (r.data.status === "waiting" && !r.data.problem && Date.now() - started < RECHECK_FOR_MS)
        timer = setTimeout(() => void look(), RECHECK_MS);
    };
    void look();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [media.id]);
  const noun = media.kind === "audio" && !media.voice ? "audio file" : NOUN[media.kind];
  if (!info) return <div className={s.mediaWait} aria-hidden />;
  if (info.status === "waiting" && !info.problem)
    return (
      <div className={s.mediaNote}>
        <span>Getting this {noun} from WhatsApp…</span>
        <div className={s.mediaWait} aria-hidden />
      </div>
    );
  if (info.status !== "ready")
    return (
      <p className={s.mediaNote}>
        {info.problem ?? `LUME couldn’t fetch this ${noun}. Open it on the phone.`}
      </p>
    );
  if (broken) return <p className={s.mediaNote}>LUME couldn’t show this {noun}. Open it on the phone.</p>;
  const src = mediaUrl(media.id);
  const label = `${noun[0]!.toUpperCase()}${noun.slice(1)} from ${from}`;
  if (media.kind === "image" || media.kind === "sticker")
    return <img className={s.photo} src={src} alt={label} loading="lazy" onError={() => setBroken(true)} />;
  if (media.kind === "video")
    return (
      <video
        className={s.photo}
        src={src}
        controls
        preload="metadata"
        aria-label={label}
        onError={() => setBroken(true)}
      />
    );
  if (media.kind === "audio")
    return <audio className={s.audio} src={src} controls preload="metadata" aria-label={label} />;
  return (
    <a className={s.doc} href={src}>
      <span className={s.docType} aria-hidden>
        {typeWord(info.mime, info.filename)}
      </span>
      <span className={s.docText}>
        <span className={s.docName}>{info.filename ?? "Document"}</span>
        <span className={s.docMeta}>
          {[typeWord(info.mime, info.filename), sizeWords(info.size), "Download"].filter(Boolean).join(" · ")}
        </span>
      </span>
    </a>
  );
}

const STATUS_WORDS = {
  queued: "Sending…",
  sending: "Sending…",
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
};

/**
 * Where a reply sent from LUME has got to (plan W3a; canvas board Statuses): a tick for sent, two for delivered, blue
 * for read, in words too; and why it didn't go, with Try again for words (a file needs attaching again).
 */
function SendStatus({
  m,
  onRetry,
}: {
  m: WaThreadMessage;
  onRetry?: ((m: WaThreadMessage) => void) | undefined;
}) {
  if (!m.status) return null;
  if (m.status === "failed")
    return (
      <span className={s.failed}>
        <span>{m.problem ?? "This message didn't go."}</span>
        {onRetry && !m.media && (
          <button type="button" className={s.retry} onClick={() => onRetry(m)}>
            Try again
          </button>
        )}
      </span>
    );
  const two = m.status === "delivered" || m.status === "read";
  const one = m.status === "sent";
  return (
    <span className={s.status} data-status={m.status}>
      {two && (
        <svg
          aria-hidden="true"
          width="16"
          height="10"
          viewBox="0 0 16 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M1 5.5 3.8 8.2 9.5 1.8" />
          <path d="M6.5 8.2 12.5 1.8" />
        </svg>
      )}
      {one && (
        <svg
          aria-hidden="true"
          width="12"
          height="10"
          viewBox="0 0 12 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M1.5 5.5 4.3 8.2 10.5 1.8" />
        </svg>
      )}
      {STATUS_WORDS[m.status]}
    </span>
  );
}

/**
 * A lead's WhatsApp messages (spec 2026-10-18 §4.2; canvas board Thread): oldest first, grouped by day; the lead's on
 * one side, the business phone's on the other. Each message is one list item, heard as who, when, then what.
 */
export function WhatsAppThread({
  leadName,
  tz,
  messages,
  onRetry,
  onMeaning,
  composer,
}: {
  leadName: string;
  tz: string;
  messages: WaThreadMessage[];
  /** A reply from LUME that didn't go, sent again as a new message (plan W3a). */
  onRetry?: (m: WaThreadMessage) => void;
  /** A reply's suggested next step was applied (W2): the thread and the lead are read again. */
  onMeaning?: () => void;
  /** The reply box (plan W3a), when this person may reply from LUME; in place of the line about replying on the phone. */
  composer?: ReactNode;
}) {
  const who = first(leadName);
  const reduce = useReducedMotion();
  // A message that arrives, or one just sent, rises in from the reply box; the rest stay still (initial={false}).
  const rise = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 } }
    : { initial: { opacity: 0, y: 12, scale: 0.98 }, animate: { opacity: 1, y: 0, scale: 1 } };
  if (!messages.length)
    return (
      <>
        <p className={s.empty}>
          No WhatsApp messages with {who} yet. When {who} writes to your number, it shows up here.
        </p>
        {composer}
      </>
    );
  const today = dayKey(new Date(), tz);
  const dayWords = (iso: string) => {
    const k = dayKey(new Date(iso), tz);
    return k === today ? "Today" : k === addDays(today, -1) ? "Yesterday" : longDate(new Date(iso), tz);
  };
  const rows: ({ day: string } | { m: WaThreadMessage })[] = [];
  let last = "";
  for (const m of messages) {
    const d = dayKey(new Date(m.at), tz);
    if (d !== last) rows.push({ day: dayWords(m.at) });
    last = d;
    rows.push({ m });
  }
  return (
    <div className={s.thread}>
      <ol className={s.list} aria-label={`WhatsApp messages with ${who}`}>
        <AnimatePresence initial={false}>
          {rows.map((r) =>
            "day" in r ? (
              <li key={`d-${r.day}`} className={s.day}>
                {r.day}
              </li>
            ) : (
              <motion.li
                key={r.m.id}
                className={s.msg}
                data-direction={r.m.direction}
                {...rise}
                transition={toMotion(SPRINGS.default)}
                style={{ transformOrigin: r.m.direction === "out" ? "100% 100%" : "0% 100%" }}
              >
                <span className={s.meta}>
                  {r.m.direction === "in"
                    ? who
                    : r.m.lumeAi && r.m.sentBy
                      ? `LUME AI for ${r.m.sentBy.name}`
                      : (r.m.sentBy?.name ?? "From the phone")}
                  , {timeOf(new Date(r.m.at), tz)}
                  <span className={s.srOnly}>: </span>
                </span>
                <div className={s.bubble}>
                  {r.m.media && <MediaPart media={r.m.media} from={who} />}
                  {r.m.text && <span className={s.text}>{r.m.text}</span>}
                </div>
                <SendStatus m={r.m} onRetry={onRetry} />
                {r.m.direction === "in" && r.m.meaning && (
                  <ReplyMeaning meaning={r.m.meaning} from={who} tz={tz} onDone={() => onMeaning?.()} />
                )}
              </motion.li>
            ),
          )}
        </AnimatePresence>
      </ol>
      {composer ?? (
        <p className={s.foot}>
          Replies arrive here by themselves. Reply on your phone; it shows up here too.
        </p>
      )}
    </div>
  );
}
