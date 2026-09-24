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
import { DESIGNED_VOLUME, createSoundPlayer, type SoundCue } from "@/lib/sound";

type SoundApi = {
  play(cue: SoundCue): void;
  enabled: boolean;
  setEnabled(v: boolean): void;
  volume: number;
  setVolume(v: number): void;
};
const SoundContext = createContext<SoundApi>({
  play: () => undefined,
  enabled: false,
  setEnabled: () => undefined,
  volume: DESIGNED_VOLUME,
  setVolume: () => undefined,
});
const KEY = "lume.sound";
const VOLUME_KEY = "lume.sound.volume";

export function SoundProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState(true);
  const enabledRef = useRef(true);
  const [volume, setVolumeState] = useState(DESIGNED_VOLUME);
  const volumeRef = useRef(DESIGNED_VOLUME);
  const player = useMemo(
    () =>
      createSoundPlayer({
        createContext: () => new AudioContext(),
        isEnabled: () => enabledRef.current,
        volume: () => volumeRef.current,
      }),
    [],
  );

  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved !== null) {
        enabledRef.current = saved === "on";
        setEnabledState(enabledRef.current);
      }
      const v = Number(localStorage.getItem(VOLUME_KEY));
      if (localStorage.getItem(VOLUME_KEY) !== null && Number.isFinite(v)) {
        volumeRef.current = v;
        setVolumeState(v);
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

  const setVolume = useCallback((v: number) => {
    volumeRef.current = v;
    setVolumeState(v);
    try {
      localStorage.setItem(VOLUME_KEY, String(v));
    } catch {
      /* ignore */
    }
  }, []);

  const api = useMemo(
    () => ({ play: (c: SoundCue) => player.play(c), enabled, setEnabled, volume, setVolume }),
    [player, enabled, setEnabled, volume, setVolume],
  );
  return <SoundContext.Provider value={api}>{children}</SoundContext.Provider>;
}

export const useSound = () => useContext(SoundContext);
