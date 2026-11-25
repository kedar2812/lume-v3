import { describe, expect, it } from "vitest";
import {
  CHAT_LIMITS,
  bodyOf,
  bodyProblem,
  channelNameProblem,
  runsOf,
  ticksOf,
  typingWords,
  unreadSum,
} from "./rules";

/** Team Chat's shared rules (plan 2026-11-24-team-chat-2a, Task 2): the same on the server and on screen. */
describe("team chat's rules", () => {
  it("a message is 1 to 4,000 characters once trimmed; a file alone may have none", () => {
    expect(CHAT_LIMITS.body).toBe(4000);
    expect(bodyProblem("x".repeat(4000), false)).toBeNull();
    expect(bodyProblem("x".repeat(4001), false)).toBe("A message can be at most 4,000 characters.");
    expect(bodyProblem("   \n ", false)).toBe("Write a message or add a file.");
    expect(bodyProblem("", true)).toBeNull();
    // Characters as people count them: an emoji is one.
    expect(bodyProblem("🎉".repeat(4000), false)).toBeNull();
    expect(bodyOf("  hello\r\nthere  ")).toBe("hello\nthere");
  });

  it("a channel's name is lower case letters, digits and dashes, at most 80", () => {
    expect(channelNameProblem("sales")).toBeNull();
    expect(channelNameProblem("spring-batch-2026")).toBeNull();
    expect(channelNameProblem("a".repeat(80))).toBeNull();
    expect(channelNameProblem("a".repeat(81))).toBe("A channel's name can be at most 80 characters.");
    expect(channelNameProblem("Sales Team")).toBe(
      "Use lower case letters, digits and dashes, like spring-batch.",
    );
    expect(channelNameProblem("-sales")).toBe(
      "Use lower case letters, digits and dashes, like spring-batch.",
    );
    expect(channelNameProblem("")).toBe("Name the channel.");
  });

  it("says who is typing: one, two, then several", () => {
    expect(typingWords([])).toBe("");
    expect(typingWords(["Maya Kapoor"])).toBe("Maya Kapoor is typing…");
    expect(typingWords(["Maya Kapoor", "Rahul Mehta"])).toBe("Maya Kapoor and Rahul Mehta are typing…");
    expect(typingWords(["A", "B", "C"])).toBe("Several people are typing…");
  });

  it("an unread sum is empty at none, and 99+ past 99", () => {
    expect(unreadSum([0, 0])).toBe("");
    expect(unreadSum([3, 2])).toBe("5");
    expect(unreadSum([99])).toBe("99");
    expect(unreadSum([60, 40])).toBe("99+");
  });

  it("runs: mine on the right, others on the left; a run breaks on another person, a new day, or a 5-minute gap", () => {
    const at = (m: number) => new Date(Date.UTC(2026, 10, 24, 10, 0, 0) + m).toISOString();
    const out = runsOf(
      [
        { authorId: "a", createdAt: at(0) },
        { authorId: "a", createdAt: at(60_000) },
        { authorId: "a", createdAt: at(60_000 + 5 * 60_000 + 1000) },
        { authorId: "me", createdAt: at(7 * 60_000) },
        { authorId: null, createdAt: at(8 * 60_000) },
        { authorId: null, createdAt: at(24 * 60 * 60_000) },
      ],
      "me",
      "Asia/Kolkata",
    );
    expect(out.map((m) => [m.side, m.head])).toEqual([
      ["in", true],
      ["in", false],
      ["in", true],
      ["mine", true],
      ["in", true],
      ["in", true],
    ]);
  });

  it("ticks: seen when everyone else has read it, delivered when everyone else's device has it", () => {
    expect(ticksOf(5, [])).toBe("sent");
    expect(ticksOf(5, [{ lastDeliveredId: 4, lastReadId: 0 }])).toBe("sent");
    expect(ticksOf(5, [{ lastDeliveredId: 5, lastReadId: 0 }])).toBe("delivered");
    expect(
      ticksOf(5, [
        { lastDeliveredId: 9, lastReadId: 9 },
        { lastDeliveredId: 5, lastReadId: 4 },
      ]),
    ).toBe("delivered");
    expect(ticksOf(5, [{ lastDeliveredId: 0, lastReadId: 5 }])).toBe("seen");
  });
});
