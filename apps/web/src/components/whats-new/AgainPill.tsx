"use client";
import { SmallRoll } from "./SmallRoll";
import { useWhatsNew } from "./WhatsNewProvider";
import s from "./whats-new.module.css";

/**
 * After the window closes, the way back on Today (spec 2026-11-02): "What's new in version 1.2.0", the version rolling
 * now and then. Pressing it opens the window again, the whole opening included; its own X puts it away for good.
 */
export function AgainPill() {
  const { release, stories, state, isOpen, open, hidePill } = useWhatsNew();
  if (!release || stories.length === 0 || isOpen) return null;
  if (state.seen !== release.version || state.pillGone === release.version) return null;
  const name = `What's new in version ${release.version}`;
  return (
    <div className={s.again}>
      <button type="button" className={s.againGo} aria-label={name} onClick={() => open()}>
        <img src="/lume-mark.png" alt="" />
        <span aria-hidden>
          What&apos;s new in version <SmallRoll from={release.from} to={release.version} />
        </span>
      </button>
      <button type="button" className={s.againX} aria-label={`Hide ${name}`} onClick={hidePill}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
