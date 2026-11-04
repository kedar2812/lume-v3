"use client";
import { AiGlyph } from "@/components/ai/AiGlyph";
import { WhatsAppIcon } from "@/components/ui/WhatsAppIcon";
import type { DemoProps } from ".";
import s from "./demos.module.css";

/**
 * LUME AI books your calls: Arjun asks for Thursday at 5, LUME AI writes (the Loop drawing), says yes with the Meet
 * link, and the call lands in the Calendar. Fictional people only.
 */
export function CallsDemo({ playing }: DemoProps) {
  return (
    <div className={`${s.scene} ${s.calls}`} data-playing={playing || undefined}>
      <div className={`${s.panel} ${s.chat}`}>
        <div className={s.chatBar}>
          <span className={s.av} style={{ background: "#0b7285" }}>
            AR
          </span>
          <span className={s.who}>
            <b>Arjun Rao</b>
            <small>WhatsApp</small>
          </span>
          <WhatsAppIcon size={18} />
        </div>
        <div className={s.msgs}>
          <div className={`${s.m} ${s.lead} ${s.t1}`}>Can we talk Thursday at 5?</div>
          {playing && (
            <div className={s.writing} aria-hidden>
              <AiGlyph size={16} draw="pen" />
              LUME AI is writing
            </div>
          )}
          <div className={`${s.m} ${s.ai} ${s.t2}`}>
            Yes, Thursday at 5:00 PM works. Google Meet: <u>meet.google.com/rqa-mxtp-kcb</u>
          </div>
          <div className={`${s.sig} ${s.t3}`}>
            <AiGlyph size={13} draw="loop" />
            Sent by LUME AI
          </div>
        </div>
        <div className={s.foot}>
          <span className={s.box}>Write to Arjun</span>
          <span className={s.send}>Send</span>
        </div>
      </div>
      {playing && (
        <div className={s.ticket} aria-hidden>
          <img src="/brand/google-meet.png" alt="" width={18} height={18} />
          <b>Call booked</b>
        </div>
      )}
      <div className={`${s.panel} ${s.cal} ${s.t4}`}>
        <div className={s.calTop}>
          <b>Calendar</b>
          <small>Thursday</small>
        </div>
        <div className={s.day}>
          <span className={s.h}>4 PM</span>
          <span className={`${s.c} ${s.busy}`}>Site visit</span>
          <span className={s.h}>5 PM</span>
          <span className={s.c}>
            <span className={`${s.slot} ${s.t5}`}>
              <span className={s.slotHead}>
                <img src="/brand/google-meet.png" alt="Google Meet" width={14} height={14} />
                <b>Call with Arjun</b>
              </span>
              <small>Thursday, 5:00 PM</small>
            </span>
          </span>
          <span className={s.h}>6 PM</span>
          <span className={s.c} />
        </div>
      </div>
    </div>
  );
}
