"use client";
import { motion, useReducedMotion } from "motion/react";
import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Scrim } from "@/components/ui/Scrim";
import { WhatsAppIcon } from "@/components/ui/WhatsAppIcon";
import { useModalFocus } from "@/components/ui/useModalFocus";
import { SPRINGS, toMotion } from "@/lib/motion";
import type { WaThreadMessage } from "@/lib/whatsapp/types";
import { WhatsAppThread } from "./WhatsAppThread";
import s from "./whatsapp.module.css";

/** Within this of the bottom, a new message keeps the newest in view; further up, the person is reading back. */
const NEAR_BOTTOM_PX = 140;

/**
 * A lead's WhatsApp as a window of its own (owner, 2026-10-31): over the whole of LUME, dimmed and blurred behind it,
 * the messages scrolling between a header that says who it is and the reply box pinned at the foot, as WhatsApp
 * itself is laid out. The newest message is in view on opening, and stays so as messages arrive, unless the person
 * has scrolled up to read. Escape or Close goes back to the lead.
 */
export function WhatsAppChat({
  leadName,
  phone,
  tz,
  messages,
  onClose,
  onRetry,
  onMeaning,
  composer,
}: {
  leadName: string;
  /** The lead's number as people read it, under their name. */
  phone: string | null;
  tz: string;
  messages: WaThreadMessage[];
  onClose(): void;
  onRetry?: (m: WaThreadMessage) => void;
  onMeaning?: () => void;
  /** The reply box (or the approved templates outside 24 hours); without it, where replies go instead. */
  composer?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const near = useRef(true);
  const reduce = useReducedMotion();
  const focus = useModalFocus(panel, onClose);

  // Into the reply box at once, as on WhatsApp; Close when there's nothing to write in.
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>("[data-chat-foot] textarea")?.focus();
  }, []);
  // The newest message in view: on opening, and when one arrives while the person is at the bottom.
  useLayoutEffect(() => {
    const el = body.current;
    if (el && near.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  return (
    <Scrim onClose={onClose} className={s.chatLayer}>
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={`WhatsApp with ${leadName}`}
        className={s.chat}
        onKeyDown={focus.onKeyDown}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={reduce ? { duration: 0.18 } : toMotion(SPRINGS.default)}
      >
        <header className={s.chatHead}>
          <WhatsAppIcon size={32} />
          <div className={s.chatWho}>
            <h2 className={s.chatName}>{leadName}</h2>
            {phone && <span className={s.chatPhone}>{phone}</span>}
          </div>
          <button type="button" className={s.chatClose} aria-label="Close (Esc)" onClick={onClose}>
            <X size={18} aria-hidden />
          </button>
        </header>
        <div
          ref={body}
          className={s.chatBody}
          data-chat-body
          onScroll={(e) => {
            const el = e.currentTarget;
            near.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
          }}
        >
          <WhatsAppThread
            leadName={leadName}
            tz={tz}
            messages={messages}
            onRetry={onRetry}
            onMeaning={onMeaning}
            bare
          />
        </div>
        <div className={s.chatFoot} data-chat-foot>
          {composer ?? (
            <p className={s.foot}>Replies arrive here by themselves. Reply on your phone; it shows up here too.</p>
          )}
        </div>
      </motion.div>
    </Scrim>
  );
}
