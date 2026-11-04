"use client";
import type { StoryId } from "@lume/core/shared";
import { useWhatsNew } from "./WhatsNewProvider";
import s from "./whats-new.module.css";

/**
 * "New" beside a story's place (a sidebar item, a settings section, a button), for a week from the release or until
 * it's used (spec 2026-11-02). `dot` is the phone tab bar's: no room for a word (the menu item beside it says New).
 */
export function NewPill({
  story,
  dot = false,
  end = false,
}: {
  story: StoryId;
  dot?: boolean;
  end?: boolean;
}) {
  const { isStoryNew } = useWhatsNew();
  if (!isStoryNew(story)) return null;
  // `end`: pushed to the end of a nav row, as the Live pill is.
  return dot ? <NewDot /> : <span className={end ? `${s.newPill} ${s.newEnd}` : s.newPill}>New</span>;
}

/** The phone's dot: on a tab, or on More when something new is under it. */
export const NewDot = () => <span className={s.newDot} data-new aria-hidden />;
