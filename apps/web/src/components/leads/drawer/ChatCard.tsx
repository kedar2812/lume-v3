"use client";
import { Button } from "@/components/ui/Button";
import { WhatsAppIcon } from "@/components/ui/WhatsAppIcon";
import { dayKey, longDate, timeOf } from "@/lib/dates";
import type { WaThreadMessage } from "@/lib/whatsapp/types";
import s from "./whatsapp.module.css";

const first = (name: string) => name.trim().split(/\s+/)[0] || name;
const NOUN = { image: "Photo", sticker: "Sticker", video: "Video", audio: "Voice note", document: "Document" } as const;

/**
 * The WhatsApp tab, while the chat is a window of its own (2026-10-31): the latest message at a glance, and Open chat
 * to go back in after closing it.
 */
export function ChatCard({
  leadName,
  tz,
  last,
  onOpen,
}: {
  leadName: string;
  tz: string;
  last: WaThreadMessage | null;
  onOpen(): void;
}) {
  const who = first(leadName);
  const when = (iso: string) => {
    const d = new Date(iso);
    return dayKey(d, tz) === dayKey(new Date(), tz) ? timeOf(d, tz) : longDate(d, tz);
  };
  const words = last ? (last.text ?? (last.media ? NOUN[last.media.kind] : "")) : "";
  return (
    <section className={s.chatCard} aria-label={`WhatsApp with ${who}`}>
      <WhatsAppIcon size={36} />
      <div className={s.chatCardText}>
        <b>WhatsApp with {who}</b>
        <span className={s.chatCardLast}>
          {last ? `${last.direction === "in" ? who : "You"}: ${words}` : `No messages with ${who} yet`}
        </span>
        {last && <span className={s.chatCardWhen}>{when(last.at)}</span>}
      </div>
      <Button size="sm" onClick={onOpen}>
        Open chat
      </Button>
    </section>
  );
}
