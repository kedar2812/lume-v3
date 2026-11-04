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
  isNew,
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
  /** "New" beside a story's place: for a week, until used; kept while they're on the page that used it. */
  isStoryNew: (id: StoryId) => boolean;
  /** Today's pill put away for good, for this version. */
  hidePill: () => void;
  /** The window is showing (Today's pill waits for it to close). */
  isOpen: boolean;
  state: WhatsNewState;
  release: Release | null;
  stories: Story[];
};
const WhatsNewContext = createContext<WhatsNewApi>({
  open: () => undefined,
  showMe: () => undefined,
  isStoryNew: () => false,
  hidePill: () => undefined,
  isOpen: false,
  state: EMPTY_WHATS_NEW,
  release: null,
  stories: [],
});
export const useWhatsNew = () => useContext(WhatsNewContext);
/** The story, if any, whose place is this nav item's page (for its "New"). */
export function useStoryAt(): (href: string) => StoryId | undefined {
  const { stories } = useWhatsNew();
  return (href) => stories.find((x) => x.place.route === href)?.id;
}

/** Never during a task: setup, onboarding, an import being mapped. */
const BUSY = [/^\/setup(\/|$)/, /^\/onboarding(\/|$)/, /^\/settings\/imports\/./];
const busyPath = (p: string) => BUSY.some((r) => r.test(p));
/** A sheet, or a small form or menu (a half-typed message is never covered up). */
const sheetOpen = () => document.querySelector('[aria-modal="true"], [data-popover]') !== null;
/** Tabs of the same browser tell each other the window was shown, so one that was waiting doesn't show it again. */
const CHANNEL = "lume-whats-new";

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
  // Where "New" counts from on this installation (every client updates on its own day).
  const since = session.whatsNew.since ? Date.parse(`${session.whatsNew.since}T00:00:00Z`) : undefined;
  const release = useMemo(() => releaseFor(version), [version]);
  const stories = useMemo(
    () => (release ? release.stories.filter((s) => ids.includes(s.id)) : []),
    [release, ids],
  );
  const [state, setState] = useState<WhatsNewState>(session.whatsNew.state);
  const [win, setWin] = useState<{ at: number; overture: boolean; key: number } | null>(null);
  const [spot, setSpot] = useState<Story | null>(null);
  // The story whose place is open now and was new on arrival: its pills stay until they leave.
  const [here, setHere] = useState<StoryId | null>(null);
  const stateNow = useRef(state);
  stateNow.current = state;
  const autoDone = useRef(false);
  const due = session.flags.needsWhatsNew && !!release && stories.length > 0;

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined" || !release) return;
    const ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = (e: MessageEvent<{ seen?: string }>) => {
      if (e.data?.seen === release.version) autoDone.current = true;
    };
    return () => ch.close();
  }, [release]);

  useEffect(() => {
    if (!due || autoDone.current || !release) return;
    const tryOpen = () => {
      if (autoDone.current) return true;
      if (busyPath(pathname) || tour.active || sheetOpen()) return false;
      autoDone.current = true;
      setWin({ at: 0, overture: true, key: Date.now() });
      void client.save({ seen: release.version }).then((s) => s && setState(s));
      if (typeof BroadcastChannel !== "undefined") {
        const ch = new BroadcastChannel(CHANNEL);
        ch.postMessage({ seen: release.version });
        ch.close();
      }
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

  // Opening a story's place counts as using it.
  useEffect(() => {
    const story = stories.find((x) => pathname === x.place.route || pathname.startsWith(`${x.place.route}/`));
    if (!story || !release) return setHere(null);
    if (!isNew({ state: stateNow.current, release, story: story.id, now: new Date(), since })) return;
    setHere(story.id);
    void client.save({ used: story.id }).then((next) => next && setState(next));
  }, [pathname, stories, release, client, since]);

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

  const isStoryNew = useCallback(
    (id: StoryId) =>
      !!release &&
      stories.some((x) => x.id === id) &&
      (id === here || isNew({ state, release, story: id, now: new Date(), since })),
    [release, stories, here, state, since],
  );

  const hidePill = useCallback(() => {
    if (!release) return;
    setState((cur) => ({ ...cur, pillGone: release.version }));
    void client.save({ pillGone: release.version });
  }, [release, client]);

  const api = useMemo<WhatsNewApi>(
    () => ({ open, showMe, isStoryNew, hidePill, isOpen: !!win, state, release, stories }),
    [open, showMe, isStoryNew, hidePill, win, state, release, stories],
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
