"use client";
import type { Story } from "@lume/core/shared";
import { DEMOS } from "./demos";
import { StoryMark, kickerLabel } from "./StoryMark";
import s from "./whats-new.module.css";

/** One story: its kicker, the headline rising line by line, its sentence, the moves; on the right, the feature playing. */
export function Stage({
  story,
  at,
  total,
  playing,
  round,
  onNext,
  actions,
}: {
  story: Story;
  at: number;
  total: number;
  playing: boolean;
  round: number;
  onNext: () => void;
  /** Show me, from the window (Task 6). */
  actions?: React.ReactNode;
}) {
  const Demo = DEMOS[story.id];
  const last = at === total - 1;
  return (
    <div className={s.stage}>
      <div key={round} className={s.words} data-enter={playing || undefined}>
        <span className={s.kicker}>
          <StoryMark kicker={story.kicker} />
          {kickerLabel(story.kicker)}
        </span>
        <h2 className={s.headline}>
          {story.head.map((line) => (
            <span key={line} className={s.line}>
              <span>{line}</span>
            </span>
          ))}
        </h2>
        <p className={s.sub}>{story.sub}</p>
        <div className={s.actions}>
          {actions}
          <button type="button" className={s.ghost} onClick={onNext}>
            {last ? "Done" : "Next"}
          </button>
        </div>
        <span className={s.count}>
          {at + 1} of {total}
        </span>
      </div>
      <div className={s.demo}>{Demo && <Demo key={round} playing={playing} />}</div>
    </div>
  );
}
