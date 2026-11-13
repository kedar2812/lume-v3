import { describe, expect, it } from "vitest";
import { meetingMessage, scheduleMeetingSchema, SCHEDULE_MINUTES } from "./schedule";

/** Schedule a meeting (owner, 2026-11-13): from a lead's card or the Calendar, with a Meet link, then WhatsApp. */
const ok = {
  leadId: "0190e0c0-0000-7000-8000-0000000000a1",
  title: "Call with Meera",
  startsAt: "2026-11-20T11:30:00.000Z",
  minutes: 30,
  notes: "",
};

describe("schedule a meeting", () => {
  it("takes a lead, a title, a start, a length and notes", () => {
    expect(scheduleMeetingSchema.parse({ ...ok, title: "  Call with Meera  " }).title).toBe(
      "Call with Meera",
    );
    expect(SCHEDULE_MINUTES).toEqual([15, 30, 45, 60, 90]);
  });

  it("refuses an empty title, a length that isn't offered, a time it can't read and notes past 1,000", () => {
    const why = (o: object) => scheduleMeetingSchema.safeParse({ ...ok, ...o }).error?.issues[0]?.message;
    expect(why({ title: "   " })).toBe("Give the meeting a title.");
    expect(why({ title: "x".repeat(201) })).toBe("A title is at most 200 characters.");
    expect(why({ minutes: 20 })).toBe("A meeting is 15, 30, 45, 60 or 90 minutes.");
    expect(why({ startsAt: "tomorrow" })).toBe("Choose a day and a time.");
    expect(why({ notes: "x".repeat(1001) })).toBe("Notes are at most 1,000 characters.");
  });

  it("the WhatsApp message: their first name, the time on the business's clock, month first, and the link", () => {
    expect(
      meetingMessage({
        name: "Meera Iyer",
        at: new Date("2026-11-20T11:30:00Z"),
        tz: "Asia/Kolkata",
        link: "https://meet.google.com/abc-defg-hij",
      }),
    ).toBe(
      "Hi Meera, here's the Google Meet link for our call on November 20, Friday at 5 pm: https://meet.google.com/abc-defg-hij",
    );
    expect(
      meetingMessage({
        name: null,
        at: new Date("2026-11-20T11:45:00Z"),
        tz: "Asia/Kolkata",
        link: "https://m",
      }),
    ).toBe("Hi, here's the Google Meet link for our call on November 20, Friday at 5:15 pm: https://m");
  });
});
