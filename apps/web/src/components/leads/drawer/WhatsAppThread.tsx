"use client";
import { useEffect, useState } from "react";
import { addDays, dayKey, longDate, timeOf } from "@/lib/dates";
import { mediaUrl, whatsappClient } from "@/lib/whatsapp/client";
import type { WaMediaInfo, WaThreadMessage } from "@/lib/whatsapp/types";
import s from "./whatsapp.module.css";

const first = (name: string) => name.trim().split(/\s+/)[0] || name;
const NOUN: Record<WaMediaInfo["kind"], string> = {
  image: "photo",
  audio: "voice note",
  video: "video",
  document: "document",
  sticker: "sticker",
};
/** "1.2 MB", "84 KB". */
export function sizeWords(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
const typeWord = (mime: string, filename: string | null) =>
  mime === "application/pdf" ? "PDF" : (filename?.split(".").pop()?.toUpperCase() ?? "File");

/** One file in a message: here, on its way, or said in words when it can't be shown. */
function MediaPart({ media, from }: { media: NonNullable<WaThreadMessage["media"]>; from: string }) {
  const [info, setInfo] = useState<WaMediaInfo | null>(null);
  useEffect(() => {
    let live = true;
    void whatsappClient.mediaInfo(media.id).then((r) => live && r.ok && setInfo(r.data));
    return () => {
      live = false;
    };
  }, [media.id]);
  const noun = media.kind === "audio" && !media.voice ? "audio file" : NOUN[media.kind];
  if (!info) return <div className={s.mediaWait} aria-hidden />;
  if (info.status === "waiting")
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
  const src = mediaUrl(media.id);
  const label = `${noun[0]!.toUpperCase()}${noun.slice(1)} from ${from}`;
  if (media.kind === "image" || media.kind === "sticker")
    return <img className={s.photo} src={src} alt={label} loading="lazy" />;
  if (media.kind === "video")
    return <video className={s.photo} src={src} controls preload="metadata" aria-label={label} />;
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

/**
 * A lead's WhatsApp messages (spec 2026-10-18 §4.2; canvas board Thread): oldest first, grouped by day; the lead's on
 * one side, the business phone's on the other. Each message is one list item, heard as who, when, then what.
 */
export function WhatsAppThread({
  leadName,
  tz,
  messages,
}: {
  leadName: string;
  tz: string;
  messages: WaThreadMessage[];
}) {
  const who = first(leadName);
  if (!messages.length)
    return (
      <p className={s.empty}>
        No WhatsApp messages with {who} yet. When {who} writes to your number, it shows up here.
      </p>
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
        {rows.map((r) =>
          "day" in r ? (
            <li key={`d-${r.day}`} className={s.day}>
              {r.day}
            </li>
          ) : (
            <li key={r.m.id} className={s.msg} data-direction={r.m.direction}>
              <span className={s.meta}>
                {r.m.direction === "in" ? who : "From the phone"}, {timeOf(new Date(r.m.at), tz)}
                <span className={s.srOnly}>: </span>
              </span>
              <div className={s.bubble}>
                {r.m.media && <MediaPart media={r.m.media} from={who} />}
                {r.m.text && <span className={s.text}>{r.m.text}</span>}
              </div>
            </li>
          ),
        )}
      </ol>
      <p className={s.foot}>Replies arrive here by themselves. Reply on your phone; it shows up here too.</p>
    </div>
  );
}
