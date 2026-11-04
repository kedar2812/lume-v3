"use client";
import type { Release, Story } from "@lume/core/shared";
import { StoryMark } from "./StoryMark";
import s from "./whats-new.module.css";

export const railTitle = (story: Story): string => story.head.join(" ").replace(/\.$/, "");

/** The version's stories down the left (a strip across the top on a narrow screen), and the smaller changes. */
export function Rail({
  release,
  stories,
  at,
  playing,
  round,
  onPick,
}: {
  release: Release;
  stories: Story[];
  at: number;
  playing: boolean;
  /** Changes on every move, so the current story's progress line starts again. */
  round: number;
  onPick: (i: number) => void;
}) {
  return (
    <nav className={s.rail} aria-label="This update">
      <div className={s.label}>In {release.version}</div>
      {stories.map((story, i) => (
        <button
          key={story.id}
          type="button"
          className={s.chap}
          data-on={i === at || undefined}
          aria-current={i === at ? "step" : undefined}
          onClick={() => onPick(i)}
        >
          <span className={s.ic}>
            <StoryMark kicker={story.kicker} />
          </span>
          <span className={s.chapText}>
            <b>{railTitle(story)}</b>
            <small>{story.note}</small>
          </span>
          {i === at && (
            <span className={s.bar} aria-hidden>
              <i
                key={round}
                data-playing={playing || undefined}
                style={{ animationDuration: `${story.ms}ms` }}
              />
            </span>
          )}
        </button>
      ))}
      {release.alsoNew.length > 0 && (
        <div className={s.alsonew}>
          <div className={s.alsoLabel}>Also new</div>
          <ul>
            {release.alsoNew.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </nav>
  );
}
