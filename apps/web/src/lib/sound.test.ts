import { describe, expect, it } from "vitest";
import { CUE_NOTES, SOUND_CUES, createSoundPlayer, type AudioContextLike } from "./sound";

function fakeContext() {
  const started: Array<{ freq: number; at: number }> = [];
  const gains: number[] = [];
  const ctx: AudioContextLike = {
    currentTime: 10,
    state: "running",
    destination: {} as AudioDestinationNode,
    resume: async () => undefined,
    createOscillator() {
      const osc = {
        type: "sine",
        frequency: { value: 0 },
        connect: (n: unknown) => n,
        start: (at: number) => started.push({ freq: osc.frequency.value, at }),
        stop: () => undefined,
      };
      return osc as unknown as OscillatorNode;
    },
    createGain() {
      return {
        gain: {
          setValueAtTime: () => undefined,
          linearRampToValueAtTime: (v: number) => gains.push(v),
          exponentialRampToValueAtTime: () => undefined,
        },
        connect: (n: unknown) => n,
      } as unknown as GainNode;
    },
  };
  return { ctx, started, gains };
}

describe("sound policy", () => {
  it("only has the four achievement cues", () => {
    expect([...SOUND_CUES].sort()).toEqual(["cleared", "done", "sent", "won"]);
  });

  it("every note is soft (gain ≤ 0.03) and short (≤ 1.2 s)", () => {
    for (const cue of SOUND_CUES)
      for (const n of CUE_NOTES[cue]) {
        expect(n.gain).toBeLessThanOrEqual(0.03);
        expect(n.dur).toBeLessThanOrEqual(1.2);
      }
  });
});

describe("createSoundPlayer", () => {
  it("is silent until unlocked by a user gesture", () => {
    const f = fakeContext();
    const p = createSoundPlayer({ createContext: () => f.ctx, isEnabled: () => true });
    p.play("done");
    expect(f.started).toHaveLength(0);
    p.unlock();
    p.play("done");
    expect(f.started.map((s) => s.freq)).toEqual(CUE_NOTES.done.map((n) => n.freq));
    expect(f.started[0]!.at).toBeCloseTo(10 + CUE_NOTES.done[0]!.at, 6);
  });

  it("respects the user's setting", () => {
    const f = fakeContext();
    let enabled = false;
    const p = createSoundPlayer({ createContext: () => f.ctx, isEnabled: () => enabled });
    p.unlock();
    p.play("won");
    expect(f.started).toHaveLength(0);
    enabled = true;
    p.play("won");
    expect(f.started).toHaveLength(CUE_NOTES.won.length);
  });

  it("never throws if audio is unavailable", () => {
    const p = createSoundPlayer({
      createContext: () => {
        throw new Error("no audio");
      },
      isEnabled: () => true,
    });
    expect(() => (p.unlock(), p.play("sent"))).not.toThrow();
  });
});
