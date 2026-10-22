import { describe, expect, it } from "vitest";
import { appliedWords, dueWords, pausedWords, resetWords } from "./words";

/** When LUME AI's limits reset, on the person's clock (spec 2026-10-18 §2.2). */
const TZ = "Asia/Kolkata";
const now = new Date("2026-10-21T10:00:00Z"); // Wednesday 3:30 pm in Kolkata

describe("LUME AI's words for time", () => {
  it("a reset today is a time, tomorrow says so, later says the day", () => {
    expect(resetWords("2026-10-21T10:10:00.000Z", TZ, now)).toBe("3:40 pm");
    expect(resetWords("2026-10-21T18:40:00.000Z", TZ, now)).toBe("tomorrow 12:10 am");
    expect(resetWords("2026-10-25T18:30:00.000Z", TZ, now)).toBe("Monday 12 am");
  });

  it("a pause says which limit and when LUME AI is back", () => {
    expect(pausedWords({ by: "hour", until: "2026-10-21T10:10:00.000Z" }, TZ, now)).toBe(
      "LUME AI has reached this hour's limit. It's back at 3:40 pm.",
    );
    expect(pausedWords({ by: "hour", until: "2026-10-21T18:40:00.000Z" }, TZ, now)).toBe(
      "LUME AI has reached this hour's limit. It's back tomorrow 12:10 am.",
    );
    expect(pausedWords({ by: "week", until: "2026-10-25T18:30:00.000Z" }, TZ, now)).toBe(
      "LUME AI has reached this week's limit. It's back Monday.",
    );
  });

  it("the month's allowance (Autopilot A1) says so, and the day it's back at the latest", () => {
    expect(pausedWords({ by: "month", until: "2026-10-31T18:30:00.000Z" }, TZ, now)).toBe(
      "LUME AI has reached this month's allowance. It's back on November 1.",
    );
  });
});

describe("LUME AI's words for a suggestion", () => {
  const names = {
    stage: "Site visit booked",
    when: "October 24, Saturday at 11 am",
    tags: ["decision pending"],
  };

  it("a follow-up's moment reads on the person's clock, with the day the way LUME writes dates", () => {
    expect(dueWords("2026-10-24T05:30:00.000Z", TZ)).toBe("October 24, Saturday at 11 am");
    expect(dueWords("2026-10-24T05:45:00.000Z", "Asia/Dubai")).toBe("October 24, Saturday at 9:45 am");
  });

  it("says everything that was applied in one sentence", () => {
    expect(appliedWords({ applied: ["stage", "followUp"], skipped: [] }, names)).toEqual({
      done: "Moved to Site visit booked and set a follow-up for October 24, Saturday at 11 am.",
      skipped: [],
    });
    expect(
      appliedWords(
        { applied: ["stage", "followUp", "tags"], skipped: [] },
        { ...names, tags: ["decision pending", "budget"] },
      ).done,
    ).toBe(
      "Moved to Site visit booked, set a follow-up for October 24, Saturday at 11 am and added the tags decision pending and budget.",
    );
  });

  it("says each part it skipped, and why, in the API's own words", () => {
    expect(
      appliedWords(
        {
          applied: ["followUp"],
          skipped: [
            { part: "stage", why: "Someone moved this lead since the suggestion." },
            { part: "tags", why: "Your role can't change tags." },
          ],
        },
        names,
      ),
    ).toEqual({
      done: "Set a follow-up for October 24, Saturday at 11 am.",
      skipped: [
        "The stage wasn't changed. Someone moved this lead since the suggestion.",
        "The tag wasn't added. Your role can't change tags.",
      ],
    });
  });

  it("nothing applied: no done sentence", () => {
    expect(
      appliedWords({ applied: [], skipped: [{ part: "followUp", why: "That time has passed." }] }, names),
    ).toEqual({ done: null, skipped: ["The follow-up wasn't set. That time has passed."] });
  });
});
