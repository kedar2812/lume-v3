"use client";
import { AiGlyph } from "@/components/ai/AiGlyph";
import type { DemoProps } from ".";
import s from "./demos.module.css";

const DRAFTS = [
  "Hi Maya, welcome! When suits you for a short call this week?",
  "Welcome, Maya. Tell me a little about your goals and I can share the next steps.",
  "Hi Maya, thanks for reaching out. Here is how to get started.",
];
const CHOSEN = 1;

/**
 * Templates, written for you: say what it's for, LUME AI writes three, one is chosen, and it goes into a chat's reply
 * box. Fictional people only.
 */
export function TemplatesDemo({ playing }: DemoProps) {
  return (
    <div className={`${s.scene} ${s.templates}`} data-playing={playing || undefined}>
      <div className={`${s.panel} ${s.writer}`}>
        <div className={s.writerHead}>
          <AiGlyph size={16} draw={playing ? "pen" : "loop"} />
          <b>Write with LUME AI</b>
        </div>
        <div className={s.ask}>
          <span className={s.typed}>Welcome a new lead</span>
        </div>
        <ul className={s.drafts}>
          {DRAFTS.map((d, i) => (
            <li
              key={d}
              className={`${s.draft} ${s[`d${i + 1}`]}`}
              aria-current={i === CHOSEN ? "true" : undefined}
              data-chosen={i === CHOSEN || undefined}
            >
              <span className={s.tick} aria-hidden>
                <svg viewBox="0 0 12 12">
                  <path d="M2.5 6.3 5 8.6l4.6-5" />
                </svg>
              </span>
              <span>{d}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className={`${s.panel} ${s.replyCard} ${s.t5}`}>
        <div className={s.replyHead}>
          <span className={s.av} style={{ background: "#b02e6b" }}>
            M
          </span>
          <b>Maya Iyer</b>
        </div>
        <div className={s.replyBox} data-testid="reply-box">
          <span className={s.flyIn}>{DRAFTS[CHOSEN]}</span>
        </div>
      </div>
    </div>
  );
}
