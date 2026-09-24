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
import { TOUR_VERSION, needsTour, tourStepsFor, type TourStep } from "@lume/core/shared";
import { useSound } from "@/components/feedback/SoundProvider";
import type { TourClient } from "@/lib/tour-client";
import type { Session } from "@/server/session";
import { TourOverlay } from "./TourOverlay";

type TourApi = { start(): void; active: boolean };
const TourContext = createContext<TourApi>({ start: () => undefined, active: false });
export const useTour = () => useContext(TourContext);

const targetOf = (step: TourStep) => document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
/** A target that isn't on screen (missing, or hidden at this width) is skipped, never pointed at. */
const isShown = (el: HTMLElement | null): el is HTMLElement =>
  !!el && (typeof el.checkVisibility !== "function" || el.checkVisibility());

/**
 * The spotlight tour (spec §5). Steps come from @lume/core for this person's permissions, filtered at
 * start to the targets actually on screen. It starts on its own once (or again when a new TOUR_VERSION
 * adds steps), when onboarding hands over with ?tour=1, and whenever someone asks to replay it.
 */
export function TourProvider({
  session,
  client,
  autoStart = false,
  children,
}: {
  session: Session;
  client: TourClient;
  autoStart?: boolean;
  children: ReactNode;
}) {
  const [steps, setSteps] = useState<TourStep[] | null>(null);
  const [index, setIndex] = useState(0);
  const sound = useSound();
  const autoStarted = useRef(false);

  const begin = useCallback(
    (at: number) => {
      const available = tourStepsFor(session.actor, session.capabilities).filter((s) => isShown(targetOf(s)));
      if (available.length === 0) return; // a screen without the shell: nothing to point at
      setIndex(Math.min(Math.max(0, at), available.length - 1));
      setSteps(available);
    },
    [session.actor, session.capabilities],
  );
  /** A replay always starts from the beginning. */
  const start = useCallback(() => begin(0), [begin]);

  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    const params = new URLSearchParams(window.location.search);
    const handedOver = params.get("tour") === "1";
    if (handedOver) {
      params.delete("tour");
      const q = params.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${q ? `?${q}` : ""}${window.location.hash}`,
      );
    }
    if (handedOver) return begin(0);
    // A tour left half-way (a closed tab) picks up where it stopped, unless it is a new version.
    if (needsTour(session.tour)) begin(session.tour.version === TOUR_VERSION ? session.tour.step : 0);
  }, [autoStart, session.tour, begin]);

  const go = useCallback(
    (i: number) => {
      setIndex(i);
      void client.saveStep(i).catch(() => undefined);
    },
    [client],
  );
  const finish = useCallback(() => {
    setSteps(null);
    sound.play("done");
    void client.complete().catch(() => undefined);
  }, [client, sound]);
  const skip = useCallback(() => {
    setSteps(null);
    void client.skip().catch(() => undefined);
  }, [client]);

  const api = useMemo(() => ({ start, active: steps !== null }), [start, steps]);
  const step = steps?.[index];
  return (
    <TourContext.Provider value={api}>
      {children}
      {steps && step && (
        <TourOverlay
          step={step}
          index={index}
          total={steps.length}
          onBack={() => index > 0 && go(index - 1)}
          onNext={() => (index < steps.length - 1 ? go(index + 1) : finish())}
          onSkip={skip}
        />
      )}
    </TourContext.Provider>
  );
}
