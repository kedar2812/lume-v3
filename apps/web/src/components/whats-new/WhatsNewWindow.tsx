"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { Release, Story } from "@lume/core/shared";
import { Scrim } from "@/components/ui/Scrim";
import { useModalFocus } from "@/components/ui/useModalFocus";
import { OVERTURE, Overture } from "./Overture";
import { Rail } from "./Rail";
import { Stage } from "./Stage";
import s from "./whats-new.module.css";

/** How long the window takes to fold away. */
export const FOLD_MS = 450;

const longDate = (ymd: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(Date.parse(`${ymd}T00:00:00Z`));

/**
 * Everything behind the window is out of reach while it's open: the app's own root and any other layer on <body>.
 * Declared before the focus hook, so on closing the app is reachable again before focus goes back into it.
 */
function useInertBehind(panel: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const layer = panel.current?.closest("[data-scrim]");
    if (!layer) return;
    const made = [...document.body.children].filter(
      (el): el is HTMLElement =>
        el instanceof HTMLElement && !el.contains(layer) && !el.hasAttribute("inert"),
    );
    made.forEach((el) => el.setAttribute("inert", ""));
    return () => made.forEach((el) => el.removeAttribute("inert"));
  }, [panel]);
}

/**
 * What's new (spec 2026-11-02): nearly the whole screen over LUME's full-window scrim. The opening rolls the version,
 * then each story plays by itself; arrows, the rail and Next move; Esc or X closes with a fold.
 */
export function WhatsNewWindow({
  release,
  stories,
  start = 0,
  overture,
  reduced,
  onClosed,
  actions,
}: {
  release: Release;
  stories: Story[];
  start?: number;
  overture: boolean;
  reduced: boolean;
  /** After the fold: unmount. */
  onClosed: () => void;
  /** The story's own buttons beside Next (Show me): given the fold, to step aside before going. */
  actions?: (story: Story, fold: (then: () => void) => void) => ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(Math.min(Math.max(0, start), stories.length - 1));
  const [stage, setStage] = useState(!overture);
  const [round, setRound] = useState(0);
  const [closing, setClosing] = useState(false);

  /** Fold away, then do `then` (close, or go somewhere). */
  const fold = useCallback(
    (then: () => void) => {
      if (reduced) return then();
      setClosing(true);
      setTimeout(then, FOLD_MS);
    },
    [reduced],
  );
  const close = useCallback(() => fold(onClosed), [fold, onClosed]);

  useInertBehind(panel);
  const focus = useModalFocus(panel, close);

  const go = useCallback(
    (i: number) => {
      setAt((i + stories.length) % stories.length);
      setRound((r) => r + 1);
      setStage(true);
    },
    [stories.length],
  );

  useEffect(() => {
    if (stage) return;
    const t = setTimeout(() => setStage(true), OVERTURE.done);
    return () => clearTimeout(t);
  }, [stage]);

  const playing = stage && !reduced && !closing;
  const story = stories[at]!;
  useEffect(() => {
    if (!playing || stories.length < 2) return;
    const t = setTimeout(() => go(at + 1), story.ms);
    return () => clearTimeout(t);
  }, [playing, at, round, story.ms, stories.length, go]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    focus.onKeyDown(e);
    if (e.key === "ArrowRight") go(at + 1);
    if (e.key === "ArrowLeft") go(at - 1);
  };

  return (
    <Scrim onClose={close} className={s.layer}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        className={s.win}
        data-closing={closing || undefined}
        data-still={reduced || undefined}
        onKeyDown={onKeyDown}
      >
        {!stage && <Overture from={release.from} to={release.version} />}
        <header className={s.head}>
          <img src="/lume-mark.png" alt="LUME" className={s.headMark} />
          <div className={s.title} id="whats-new-title">
            What&apos;s new in <span className={s.v}>{release.version}</span>
          </div>
          <span className={s.meta}>{longDate(release.date)}</span>
          <button type="button" className={s.close} aria-label="Close" onClick={close}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className={s.body}>
          <Rail release={release} stories={stories} at={at} playing={playing} round={round} onPick={go} />
          <Stage
            story={story}
            at={at}
            total={stories.length}
            playing={playing}
            round={round}
            onNext={() => (at === stories.length - 1 ? close() : go(at + 1))}
            actions={actions?.(story, fold)}
          />
        </div>
      </div>
    </Scrim>
  );
}
