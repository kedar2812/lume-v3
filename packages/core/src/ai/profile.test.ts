import { describe, expect, it } from "vitest";
import {
  AUTOPILOT_ACTIONS,
  DEFAULT_AI_PROFILE,
  AUTOPILOT_PRESETS,
  aiProfilePatchSchema,
  defaultGoalStages,
  mergeAiProfile,
  presetOf,
  profileProblem,
} from "./profile";

/** Settings → LUME AI (Autopilot spec 2026-10-19 §5, §1.1–1.3, §3): one document per business. */
const P1 = "0192a000-0000-7000-8000-000000000001";
const P2 = "0192a000-0000-7000-8000-000000000002";
const price = (over: Record<string, unknown> = {}) => ({
  id: P1,
  item: "Modular kitchen",
  price: 380000,
  unit: "per kitchen",
  notes: "",
  ...over,
});

describe("presets", () => {
  it("presets set every action, and presetOf names one or none", () => {
    for (const p of Object.values(AUTOPILOT_PRESETS))
      expect(Object.keys(p).sort()).toEqual([...AUTOPILOT_ACTIONS].sort());
    // As the owner approved them in the start sheet's mockup (2026-10-19, v4), row by row.
    expect(AUTOPILOT_PRESETS.careful).toEqual({
      first_messages: "go",
      follow_ups: "go",
      replies: "ask",
      send_files: "ask",
      book_meetings: "ask",
      move_stages: "ask",
      set_follow_ups: "go",
      fill_fields: "ask",
      answer_prices: "never",
      mark_lost: "never",
      hand_to_rep: "ask",
    });
    // Balanced (the default): talks and books; asks about the careful group (prices, lost, handing over).
    expect(AUTOPILOT_PRESETS.balanced).toEqual({
      first_messages: "go",
      follow_ups: "go",
      replies: "go",
      send_files: "go",
      book_meetings: "go",
      move_stages: "go",
      set_follow_ups: "go",
      fill_fields: "go",
      answer_prices: "ask",
      mark_lost: "ask",
      hand_to_rep: "ask",
    });
    expect(Object.values(AUTOPILOT_PRESETS.hands_off).every((a) => a === "go")).toBe(true);

    expect(presetOf(AUTOPILOT_PRESETS.careful)).toBe("careful");
    expect(presetOf({ ...AUTOPILOT_PRESETS.balanced })).toBe("balanced");
    expect(presetOf({ ...AUTOPILOT_PRESETS.careful, mark_lost: "ask" })).toBeNull();
    expect(DEFAULT_AI_PROFILE.standing.permissions).toEqual(AUTOPILOT_PRESETS.balanced);
  });
});

describe("what LUME AI knows", () => {
  it("prices keep their value", () => {
    const saved = mergeAiProfile(null, { knows: { prices: [price(), price({ id: P2, price: 1150.5 })] } });
    expect(saved.knows.prices.map((p) => p.price)).toEqual([380000, 1150.5]);
    // Through JSON (the jsonb column) and back, exactly.
    expect(mergeAiProfile(JSON.parse(JSON.stringify(saved)), {}).knows.prices).toEqual(saved.knows.prices);

    const refused = (p: number) => profileProblem({ knows: { prices: [price({ price: p })] } });
    expect(refused(-1)).toBe("A price can't be below zero.");
    expect(refused(1e13)).toBe("A price must be under 1,000,000,000,000.");
    expect(refused(1.005)).toBe("A price has at most two decimal places.");
    expect(refused(0.29)).toBeNull();
  });

  it("the lists have limits, said in words", () => {
    expect(profileProblem({ knows: { about: "x".repeat(2001) } })).toBe(
      "About your business is at most 2,000 characters.",
    );
    expect(profileProblem({ knows: { faqs: [{ q: "", a: "Yes" }] } })).toBe("Each question needs its words.");
    expect(profileProblem({ knows: { files: [P1, P1] } })).toBe("A file is chosen twice.");
    expect(profileProblem({ knows: { prices: [price(), price()] } })).toBe("A price is listed twice.");
  });
});

describe("voice and standing choices", () => {
  it("follow-up days go up, one to thirty, at most four", () => {
    expect(profileProblem({ standing: { followUpDays: [2, 5, 9] } })).toBeNull();
    expect(profileProblem({ standing: { followUpDays: [5, 2] } })).toBe(
      "Follow-up days go from the soonest to the latest, each once.",
    );
    expect(profileProblem({ standing: { followUpDays: [0] } })).toBe("A follow-up day is from 1 to 30.");
    expect(profileProblem({ standing: { followUpDays: [1, 2, 3, 4, 5] } })).toBe(
      "Up to four follow-ups after the first message.",
    );
    expect(profileProblem({ standing: { followUpDays: [] } })).toBe("Choose at least one follow-up day.");
  });

  it("a language is the lead's own, or a language code", () => {
    expect(profileProblem({ voice: { language: "match_lead" } })).toBeNull();
    expect(profileProblem({ voice: { language: "hi-IN" } })).toBeNull();
    expect(profileProblem({ voice: { language: "Hindi please" } })).toBe("Choose a language from the list.");
  });

  it("the calls LUME AI may say yes to: days and a from–to, a call's length, notice and how far ahead", () => {
    const calls = {
      windows: [{ days: [1, 2, 3, 4, 5], from: "16:00", to: "19:00" }],
      minutes: 30,
      noticeHours: 2,
      daysAhead: 14,
      how: "We'll call you on this number.",
    };
    expect(profileProblem({ standing: { calls } })).toBeNull();
    expect(DEFAULT_AI_PROFILE.standing.calls).toEqual({
      windows: [],
      minutes: 30,
      noticeHours: 2,
      daysAhead: 14,
      how: "",
      meet: false,
    });
    // LUME makes the Meet link (spec 2026-11-03): a yes or no, and a profile saved before it is still fine.
    expect(profileProblem({ standing: { calls: { ...calls, meet: true } } })).toBeNull();
    expect(profileProblem({ standing: { calls: { ...calls, meet: "yes" } } })).toBe(
      "Choose whether LUME makes a Meet link.",
    );
    const w = (x: object) => ({
      standing: { calls: { ...calls, windows: [{ ...calls.windows[0], ...x }] } },
    });
    expect(profileProblem(w({ from: "19:00", to: "16:00" }))).toBe("Each time ends after it starts.");
    expect(profileProblem(w({ from: "16:00", to: "16:00" }))).toBe("Each time ends after it starts.");
    expect(profileProblem(w({ from: "4pm" }))).toBe("A time is like 16:00.");
    expect(profileProblem(w({ days: [] }))).toBe("Choose at least one day for each time.");
    expect(profileProblem(w({ days: [1, 1] }))).toBe("A day is chosen twice.");
    expect(profileProblem(w({ days: [7] }))).toBe("Choose days from Sunday to Saturday.");
    expect(profileProblem({ standing: { calls: { ...calls, minutes: 20 } } })).toBe(
      "A call is 15, 30, 45 or 60 minutes.",
    );
    expect(profileProblem({ standing: { calls: { ...calls, noticeHours: 73 } } })).toBe(
      "Notice is from 0 to 72 hours.",
    );
    expect(profileProblem({ standing: { calls: { ...calls, daysAhead: 0 } } })).toBe(
      "How far ahead is from 1 to 60 days.",
    );
    expect(
      profileProblem({
        standing: { calls: { ...calls, windows: Array.from({ length: 15 }, () => calls.windows[0]) } },
      }),
    ).toBe("Up to 14 times.");
    // Saved and read back whole; an older profile without them reads the default.
    expect(mergeAiProfile(null, { standing: { calls } }).standing.calls).toEqual(calls);
    expect(mergeAiProfile({ standing: { dailyCap: 40 } }, {}).standing.calls).toEqual(
      DEFAULT_AI_PROFILE.standing.calls,
    );
  });

  it("there's no choice to deny being AI", () => {
    expect(aiProfilePatchSchema.safeParse({ standing: { botQuestion: "deny" } }).success).toBe(false);
  });
});

describe("saving and reading", () => {
  it("a patch changes only what it names; a permission changes only its row", () => {
    const a = mergeAiProfile(null, { voice: { tone: "formal" } });
    expect(a.voice).toEqual({ ...DEFAULT_AI_PROFILE.voice, tone: "formal" });
    const b = mergeAiProfile(a, { standing: { permissions: { mark_lost: "never" } } });
    expect(b.voice.tone).toBe("formal");
    expect(b.standing.permissions).toEqual({ ...AUTOPILOT_PRESETS.balanced, mark_lost: "never" });
  });

  it("a stored profile from an older shape keeps what still parses", () => {
    const stored = {
      knows: { about: "We design homes.", prices: "not a list", faqs: [{ q: "Hours?", a: "10 to 7" }] },
      voice: { tone: "shouty", signOff: "Team Brightpath" },
      // An action that no longer exists, and one missing: each row falls back on its own.
      standing: { permissions: { replies: "never", retired_action: "go" }, dailyCap: 40 },
    };
    const p = mergeAiProfile(stored, {});
    expect(p.knows.about).toBe("We design homes.");
    expect(p.knows.prices).toEqual([]);
    expect(p.knows.faqs).toEqual([{ q: "Hours?", a: "10 to 7" }]);
    expect(p.voice).toEqual({ ...DEFAULT_AI_PROFILE.voice, signOff: "Team Brightpath" });
    expect(p.standing.permissions).toEqual({ ...AUTOPILOT_PRESETS.balanced, replies: "never" });
    expect(p.standing.dailyCap).toBe(40);
    expect(mergeAiProfile("garbage", {})).toEqual(DEFAULT_AI_PROFILE);
  });
});

describe("goal stages from the business's own pipeline (§1.1)", () => {
  const s = (id: string, afterReply: string | null = null) => ({ id, afterReplyStageId: afterReply });
  it("the stage after the one a reply moves a lead to, and the last open stage", () => {
    // New → Contacted → Replied → Visit booked → Quote sent → Thinking (open, in order)
    const open = [s("new"), s("contacted", "replied"), s("replied"), s("visit"), s("quote"), s("thinking")];
    expect(defaultGoalStages(open)).toEqual(["visit", "thinking"]);
  });
  it("with no reply move: the second open stage, and the last", () => {
    expect(defaultGoalStages([s("a"), s("b"), s("c")])).toEqual(["b", "c"]);
  });
  it("short pipelines give what they can, never the same stage twice", () => {
    expect(defaultGoalStages([s("a"), s("b")])).toEqual(["b"]);
    expect(defaultGoalStages([s("a")])).toEqual([]);
    expect(defaultGoalStages([s("a", "b"), s("b"), s("c")])).toEqual(["c"]);
  });
});
