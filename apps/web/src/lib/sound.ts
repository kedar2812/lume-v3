/**
 * Achievement sounds (spec §6.2): synthesised, soft, short. Only these four exist on purpose.
 * Clicks, hover, navigation, toggles, panels, snooze, undo, sign-in and arrivals are silent.
 */
export type SoundCue = "done" | "sent" | "won" | "cleared";
export type Note = { freq: number; at: number; dur: number; gain: number };

export const CUE_NOTES: Record<SoundCue, readonly Note[]> = {
  done: [
    { freq: 880, at: 0, dur: 0.22, gain: 0.028 },
    { freq: 1318.5, at: 0.06, dur: 0.34, gain: 0.022 },
  ],
  sent: [
    { freq: 784, at: 0, dur: 0.2, gain: 0.024 },
    { freq: 1046.5, at: 0.06, dur: 0.24, gain: 0.022 },
    { freq: 1568, at: 0.12, dur: 0.38, gain: 0.018 },
  ],
  won: [523.3, 659.3, 784, 1046.5, 1318.5].map((freq, i) => ({
    freq,
    at: i * 0.08,
    dur: 1.2 - i * 0.1,
    gain: 0.024,
  })),
  cleared: [523.3, 659.3, 784, 1046.5].map((freq, i) => ({
    freq,
    at: i * 0.09,
    dur: 1.1 - i * 0.1,
    gain: 0.022,
  })),
};
export const SOUND_CUES = Object.keys(CUE_NOTES) as SoundCue[];

export type AudioContextLike = Pick<
  AudioContext,
  "currentTime" | "destination" | "createOscillator" | "createGain" | "resume" | "state"
>;

/** The level the cues were designed at; the volume preference scales around it (spec §4.2, 0–100). */
export const DESIGNED_VOLUME = 60;

export function createSoundPlayer(opts: {
  createContext: () => AudioContextLike;
  isEnabled: () => boolean;
  /** 0–100; defaults to the designed level. */
  volume?: () => number;
}) {
  let ctx: AudioContextLike | null = null;
  let unlocked = false;
  return {
    /** Call from a user gesture; browsers block audio before one. */
    unlock() {
      unlocked = true;
      try {
        ctx ??= opts.createContext();
        if (ctx.state === "suspended") void ctx.resume();
      } catch {
        ctx = null;
      }
    },
    play(cue: SoundCue) {
      if (!unlocked || !ctx || !opts.isEnabled()) return;
      const level = Math.min(100, Math.max(0, opts.volume?.() ?? DESIGNED_VOLUME)) / DESIGNED_VOLUME;
      if (level === 0) return;
      try {
        const t0 = ctx.currentTime;
        for (const n of CUE_NOTES[cue]) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.value = n.freq;
          const t = t0 + n.at;
          gain.gain.setValueAtTime(0, t);
          gain.gain.linearRampToValueAtTime(n.gain * level, t + 0.006);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(t);
          osc.stop(t + n.dur + 0.05);
        }
      } catch {
        /* audio is decoration; never break the action */
      }
    },
  };
}
