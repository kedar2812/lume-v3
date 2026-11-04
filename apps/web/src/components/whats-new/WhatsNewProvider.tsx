"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { useReducedMotion } from "motion/react";
import {
  EMPTY_WHATS_NEW,
  releaseFor,
  type Release,
  type Story,
  type StoryId,
  type WhatsNewState,
} from "@lume/core/shared";
import { useTour } from "@/components/tour/TourProvider";
import type { WhatsNewPatch } from "@/lib/whats-new/client";
import type { Session } from "@/server/session";
import { ShowMe } from "./ShowMe";
import { WhatsNewWindow } from "./WhatsNewWindow";
import s from "./whats-new.module.css";

export type WhatsNewClient = { save(patch: WhatsNewPatch): Promise<WhatsNewState | null> };

type WhatsNewApi = {
  /** Open the window again, the whole opening included (the Today pill, About, the profile menu). */
  open: (version?: string) => void;
  showMe: (id: StoryId) => void;
  state: WhatsNewState;
  release: Release | null;
  stories: Story[];
};
const WhatsNewContext = createContext<WhatsNewApi>({
  open: () => undefined,
  showMe: () => undefined,
  state: EMPTY_WHATS_NEW,
  release: null,
  stories: [],
});
export const useWhatsNew = () => useContext(WhatsNewContext);

/** Never during a task: setup, onboarding, an import being mapped. */
const BUSY = [/^\/setup(\/|$)/, /^\/onboarding(\/|$)/, /^\/settings\/imports\/./];
const busyPath = (p: string) => BUSY.some((r) => r.test(p));
const sheetOpen = () => document.querySelector('[aria-modal="true"]') !== null;

/**
 * What's new in LUME (spec 2026-11-02). Once per version per person, at the first page after the update: never over a
 * sheet, the tour, setup or an import; it waits and opens as soon as they're done. Seen is kept on the server.
 */
export function WhatsNewProvider({
  session,
  client,
  children,
}: {
  session: Session;
  client: WhatsNewClient;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const tour = useTour();
  const reduced = useReducedMotion() ?? false;
  const { version, stories: ids } = session.whatsNew;
  const release = useMemo(() => releaseFor(version), [version]);
  const stories = useMemo(
    () => (release ? release.stories.filter((s) => ids.includes(s.id)) : []),
    [release, ids],
  );
  const [state, setState] = useState<WhatsNewState>(session.whatsNew.state);
  const [win, setWin] = useState<{ at: number; overture: boolean; key: number } | null>(null);
  const [spot, setSpot] = useState<Story | null>(null);
  const autoDone = useRef(false);
  const due = session.flags.needsWhatsNew && !!release && stories.length > 0;

  useEffect(() => {
    if (!due || autoDone.current || !release) return;
    const tryOpen = () => {
      if (autoDone.current) return true;
      if (busyPath(pathname) || tour.active || sheetOpen()) return false;
      autoDone.current = true;
      setWin({ at: 0, overture: true, key: Date.now() });
      void client.save({ seen: release.version }).then((s) => s && setState(s));
      return true;
    };
    if (tryOpen()) return;
    // A sheet closing, a dialog going: look again on every change while it waits.
    const watch = new MutationObserver(() => {
      if (tryOpen()) watch.disconnect();
    });
    watch.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-modal"],
    });
    return () => watch.disconnect();
  }, [due, release, pathname, tour.active, client]);

  const open = useCallback(
    (v?: string) => {
      if (!release || stories.length === 0 || (v && v !== release.version)) return;
      setWin({ at: 0, overture: true, key: Date.now() });
    },
    [release, stories.length],
  );

  /** Show me: LUME opens where the story lives, and the tip points at it there. Opening it counts as used. */
  const showMe = useCallback(
    (id: StoryId) => {
      const story = stories.find((x) => x.id === id);
      if (!story) return;
      setWin(null);
      setSpot(story);
      router.push(story.place.route);
      void client.save({ used: id }).then((next) => next && setState(next));
    },
    [stories, router, client],
  );

  const api = useMemo<WhatsNewApi>(
    () => ({ open, showMe, state, release, stories }),
    [open, showMe, state, release, stories],
  );

  return (
    <WhatsNewContext.Provider value={api}>
      {children}
      {win && release && (
        <WhatsNewWindow
          key={win.key}
          release={release}
          stories={stories}
          start={win.at}
          overture={win.overture && !reduced}
          reduced={reduced}
          onClosed={() => setWin(null)}
          actions={(story, fold) => (
            <button type="button" className={s.cta} onClick={() => fold(() => showMe(story.id))}>
              Show me
            </button>
          )}
        />
      )}
      {spot && (
        <ShowMe
          key={spot.id}
          story={spot}
          onGotIt={() => setSpot(null)}
          onBack={() => {
            setSpot(null);
            setWin({ at: Math.max(0, stories.indexOf(spot)), overture: false, key: Date.now() });
          }}
        />
      )}
    </WhatsNewContext.Provider>
  );
}
