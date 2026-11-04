"use client";
import { useReducedMotion } from "motion/react";
import { SmallRoll } from "./SmallRoll";
import { StoryMark } from "./StoryMark";
import { useWhatsNew } from "./WhatsNewProvider";
import s from "./whats-new.module.css";

/**
 * Settings → About, under the facts (spec 2026-11-02): an inviting way into this version's window. LUME's mark breathes,
 * the version rolls, the stories appear one by one as chips, the arrow nudges. Still under reduced motion.
 */
export function AboutWhatsNew() {
  const { release, stories, open } = useWhatsNew();
  const still = useReducedMotion() ?? false;
  if (!release || stories.length === 0) return null;
  return (
    <button
      type="button"
      className={s.aboutNew}
      aria-label={`What's new in version ${release.version}: see what changed in this update, working`}
      data-still={still || undefined}
      onClick={() => open()}
    >
      <span className={s.aboutTile} aria-hidden>
        <img src="/lume-mark.png" alt="" />
      </span>
      <span className={s.aboutText}>
        <b>
          What&apos;s new in version <SmallRoll from={release.from} to={release.version} />
        </b>
        <span className={s.aboutSub}>See what changed in this update, working.</span>
        <span className={s.peek}>
          {stories.map((story, i) => (
            <i key={story.id} data-testid="chip" style={{ animationDelay: `${i * 0.25}s` }}>
              <StoryMark kicker={story.kicker} size={12} />
              {story.chip}
            </i>
          ))}
        </span>
      </span>
      <span className={s.aboutArrow} aria-hidden>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 12h13M13 6l6 6-6 6" />
        </svg>
      </span>
    </button>
  );
}
