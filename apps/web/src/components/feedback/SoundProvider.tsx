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
import { createSoundPlayer, type SoundCue } from "@/lib/sound";

type SoundApi = { play(cue: SoundCue): void; enabled: boolean; setEnabled(v: boolean): void };
const SoundContext = createContext<SoundApi>({
  play: () => undefined,
  enabled: false,
  setEnabled: () => undefined,
});
const KEY = "lume.sound";

export function SoundProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState(true);
  const enabledRef = useRef(true);
  const player = useMemo(
    () => createSoundPlayer({ createContext: () => new AudioContext(), isEnabled: () => enabledRef.current }),
    [],
  );

  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved !== null) {
        enabledRef.current = saved === "on";
        setEnabledState(enabledRef.current);
      }
    } catch {
      /* private mode */
    }
    const unlock = () => player.unlock();
    window.addEventListener("pointerdown", unlock, { once: true, capture: true });
    window.addEventListener("keydown", unlock, { once: true, capture: true });
    return () => {
      window.removeEventListener("pointerdown", unlock, { capture: true });
      window.removeEventListener("keydown", unlock, { capture: true });
    };
  }, [player]);

  const setEnabled = useCallback((v: boolean) => {
    enabledRef.current = v;
    setEnabledState(v);
    try {
      localStorage.setItem(KEY, v ? "on" : "off");
    } catch {
      /* ignore */
    }
  }, []);

  const api = useMemo(
    () => ({ play: (c: SoundCue) => player.play(c), enabled, setEnabled }),
    [player, enabled, setEnabled],
  );
  return <SoundContext.Provider value={api}>{children}</SoundContext.Provider>;
}

export const useSound = () => useContext(SoundContext);
