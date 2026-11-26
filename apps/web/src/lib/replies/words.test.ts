import { describe, expect, it } from "vitest";
import { aboutLine, dayWord, windowWords } from "./words";

/** Who replied's words for a row (D6a): how long a reply still reaches them, and whose lead it is. */
const NOW = new Date("2026-11-25T06:00:00Z"); // 11:30 in Kolkata, 22:00 the day before in Los Angeles
const at = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();
const KOL = "Asia/Kolkata";

describe("dayWord", () => {
  it("today, tomorrow, a weekday this week, else the date; on the business's own calendar", () => {
    expect(dayWord(at(2), NOW, KOL)).toBe("today");
    expect(dayWord(at(20), NOW, KOL)).toBe("tomorrow");
    expect(dayWord(at(72), NOW, KOL)).toBe("Saturday");
    expect(dayWord(at(24 * 9), NOW, KOL)).toBe("December 4");
    // West of UTC it is still the evening before: an hour on is "today" there, 3 hours on is past midnight.
    expect(dayWord(at(1), NOW, "America/Los_Angeles")).toBe("today");
    expect(dayWord(at(3), NOW, "America/Los_Angeles")).toBe("tomorrow");
  });
});

describe("windowWords", () => {
  const ig = (state: "open" | "human" | "closed", until: string | null) =>
    windowWords({ channel: "instagram", window: { state, until } }, NOW, KOL);
  const wa = (state: "open" | "closed", until: string | null) =>
    windowWords({ channel: "whatsapp", window: { state, until } }, NOW, KOL);

  it("time left while anyone may answer: hours, then minutes under an hour; an ad's days as the day it ends", () => {
    expect(ig("open", at(21.5))).toEqual({ text: "21 hours left to answer", tone: "ok" });
    expect(ig("open", at(1))).toEqual({ text: "1 hour left to answer", tone: "ok" });
    // Just under an hour, rounded up to the minute: an hour, never "0 hours".
    expect(ig("open", at(59.5 / 60))).toEqual({ text: "1 hour left to answer", tone: "ok" });
    expect(ig("open", at(58.5 / 60))).toEqual({ text: "59 minutes left to answer", tone: "warn" });
    expect(ig("open", at(0.5))).toEqual({ text: "30 minutes left to answer", tone: "warn" });
    expect(ig("open", at(0.001))).toEqual({ text: "1 minute left to answer", tone: "warn" });
    // A reply that just came: the whole 24 hours, said as hours; past a day (an ad's 7 days), the day it ends.
    expect(ig("open", at(24 - 0.1 / 60))).toEqual({ text: "24 hours left to answer", tone: "ok" });
    expect(ig("open", at(24))).toEqual({ text: "24 hours left to answer", tone: "ok" });
    expect(ig("open", at(25.25))).toEqual({ text: "Open until tomorrow at 12:45 pm", tone: "ok" });
    expect(ig("open", at(24 * 5))).toEqual({ text: "Open until Monday at 11:30 am", tone: "ok" });
    expect(wa("open", at(19.2))).toEqual({ text: "19 hours left on WhatsApp", tone: "ok" });
  });

  it("after Instagram's 24 hours: until when a person may; after it, or WhatsApp's, what still can", () => {
    expect(ig("human", at(30)).text).toBe(
      "Instagram’s 24 hours ended · a person can answer until tomorrow at 5:30 pm",
    );
    // The last day says when on it: "until today" alone would read as the whole day.
    expect(ig("human", at(4)).text).toBe(
      "Instagram’s 24 hours ended · a person can answer until today at 3:30 pm",
    );
    expect(ig("closed", null).text).toBe("Instagram’s window ended · they need to write first");
    expect(wa("closed", null).text).toBe(
      "WhatsApp’s 24 hours ended · an approved template can still reach them",
    );
  });
});

describe("aboutLine", () => {
  it("whose lead and where from; nobody's yet; a flow's hand-off says which flow and why", () => {
    expect(aboutLine({ ownerName: "Sana Iqbal", source: "Website form" })).toBe(
      "Sana Iqbal’s lead · Website form",
    );
    expect(aboutLine({ ownerName: null, source: null })).toBe("Nobody’s lead yet");
    expect(
      aboutLine({ ownerName: "Sana Iqbal", source: "Instagram", flow: { name: "Lead magnet", note: null } }),
    ).toBe("Lead magnet asked for a person · Sana Iqbal’s lead");
  });
});
