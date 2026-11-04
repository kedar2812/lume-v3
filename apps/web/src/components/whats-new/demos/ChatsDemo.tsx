"use client";
import { WhatsAppIcon } from "@/components/ui/WhatsAppIcon";
import type { DemoProps } from ".";
import s from "./demos.module.css";

const Ticks = () => (
  <svg className={s.ticks} viewBox="0 0 18 12" width="16" height="11" aria-label="Read">
    <path d="M1.5 6.5 4.5 9.5 11 2.5M7.5 9.5 14 2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

/**
 * Your chats, live in LUME: the chat in its own window, a message arriving as it's sent, and LUME's notice sliding in on
 * whatever screen is open. Fictional people only.
 */
export function ChatsDemo({ playing }: DemoProps) {
  return (
    <div className={`${s.scene} ${s.chats}`} data-playing={playing || undefined}>
      <div className={`${s.panel} ${s.page}`} aria-hidden>
        <span className={s.pageTitle}>Pipeline</span>
        <div className={s.cols}>
          <i />
          <i />
          <i />
        </div>
      </div>
      <div className={`${s.panel} ${s.chat} ${s.chatWin}`}>
        <div className={s.chatBar}>
          <span className={s.av} style={{ background: "#0b7285" }}>
            AR
          </span>
          <span className={s.who}>
            <b>Arjun Rao</b>
            <small className={s.live}>Live</small>
          </span>
          <WhatsAppIcon size={18} />
        </div>
        <div className={s.msgs}>
          <div className={`${s.m} ${s.me} ${s.t1}`}>
            Hi Arjun, thanks for asking about the plan.
            <Ticks />
          </div>
          <div className={`${s.m} ${s.me} ${s.t2}`}>
            The next batch starts Monday.
            <Ticks />
          </div>
          <div className={`${s.m} ${s.lead} ${s.t3}`}>What are your timings on Saturday?</div>
        </div>
        <div className={s.foot}>
          <span className={s.box}>Write to Arjun</span>
          <span className={s.send}>Send</span>
        </div>
      </div>
      <div className={`${s.notice} ${s.t4}`} role="status">
        <span className={s.av} style={{ background: "#0b7285" }}>
          AR
        </span>
        <span className={s.who}>
          <b>Arjun Rao</b>
          <small>What are your timings on Saturday?</small>
        </span>
        <WhatsAppIcon size={16} />
      </div>
    </div>
  );
}
