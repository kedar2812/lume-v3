import { describe, expect, it } from "vitest";
import { pausedWords, resetWords } from "./words";

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
});
