import { describe, expect, it } from "vitest";
import type { TaskView, TodayMeeting, TodayView } from "@/lib/tasks/types";
import { brief, waitedWords } from "./brief";

const TZ = "Asia/Kolkata";
// Monday, October 5 2026, 11:40 in Kolkata.
const NOW = new Date("2026-10-05T06:10:00Z");
const ist = (d: number, hh: number, mm = 0) =>
  new Date(Date.UTC(2026, 9, d, hh, mm) - 330 * 60_000).toISOString();
const task = (leadName: string, dueAt: string): TaskView => ({
  id: leadName,
  leadId: "l-" + leadName,
  leadName,
  title: "Follow up",
  note: null,
  dueAt,
  status: "open",
  remindMinutes: [],
  recurrence: null,
  assignee: { id: "me", name: "Me" },
  createdBy: null,
  doneAt: null,
  canEdit: true,
});
const call = (
  name: string,
  startsAt: string,
  status: TodayMeeting["status"] = "scheduled",
): TodayMeeting => ({
  id: "m-" + name,
  title: "Discovery call",
  startsAt,
  endsAt: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(),
  link: null,
  status,
  lead: { id: "l-" + name, name },
  matchedBy: "calendly",
  reminder: null,
});
const view = (o: Partial<TodayView>): TodayView => ({
  overdue: [],
  soon: [],
  later: [],
  done: 0,
  total: 0,
  meetings: [],
  ...o,
});
const words = (v: TodayView) =>
  brief(v, NOW, TZ)
    .parts.map((p) => p.text)
    .join("");

describe("what LUME says first on Today (spec: the header sentence)", () => {
  it("1 · a call within 30 minutes comes first", () => {
    const v = view({
      overdue: [task("Kenji Sato", ist(3, 16))],
      meetings: [call("Neha Joshi", ist(5, 12, 0))],
    });
    expect(words(v)).toBe(
      "Neha Joshi's call is in 20 minutes. After that, Kenji Sato, waiting since Saturday.",
    );
  });
  it("2 · otherwise the oldest overdue follow-up, then the next call", () => {
    const v = view({
      overdue: [task("Kenji Sato", ist(3, 16)), task("Sara Okafor", ist(5, 11))],
      meetings: [call("Aarav Mehta", ist(5, 12, 30))],
    });
    expect(words(v)).toBe(
      "Start with Kenji Sato, waiting since Saturday. Then Aarav Mehta's call at 12:30 pm.",
    );
    expect(brief(v, NOW, TZ).parts.find((p) => p.text === "Kenji Sato")).toMatchObject({
      tone: "bad",
      leadId: "l-Kenji Sato",
    });
  });
  it("a follow-up overdue from earlier today says when it was due", () => {
    expect(words(view({ overdue: [task("Sara Okafor", ist(5, 11))] }))).toBe(
      "Start with Sara Okafor, due at 11 am.",
    );
  });
  it("3 · nothing overdue: the next follow-up, then the next call", () => {
    const v = view({
      soon: [task("Rohan Gupta", ist(5, 14, 30))],
      meetings: [call("Omar Haddad", ist(5, 15))],
    });
    expect(words(v)).toBe(
      "Nothing overdue. Next up, Rohan Gupta at 2:30 pm, then Omar Haddad's call at 3 pm.",
    );
  });
  it("4 · nothing left: all clear", () => {
    expect(words(view({ done: 3, total: 3 }))).toBe("All clear. Everything due today is done.");
    expect(brief(view({ done: 3, total: 3 }), NOW, TZ).clear).toBe(true);
  });
  it("nothing at all today says so, without calling it a win", () => {
    expect(words(view({}))).toBe("Nothing is due today.");
    expect(brief(view({}), NOW, TZ).clear).toBe(false);
  });
  it("cancelled, moved and finished calls aren't next", () => {
    const v = view({
      soon: [task("Rohan Gupta", ist(5, 14, 30))],
      meetings: [
        call("Gone", ist(5, 12), "cancelled"),
        call("Moved", ist(5, 12), "rescheduled"),
        call("Earlier", ist(5, 9)),
      ],
    });
    expect(words(v)).toBe("Nothing overdue. Next up, Rohan Gupta at 2:30 pm.");
  });
  it("a call happening now says so", () => {
    expect(words(view({ meetings: [call("Neha Joshi", ist(5, 11, 30))] }))).toBe(
      "Neha Joshi's call is happening now.",
    );
  });
  it("never guesses anyone's gender", () => {
    const v = view({
      overdue: [task("Kenji Sato", ist(3, 16))],
      meetings: [call("Aarav Mehta", ist(5, 12, 30))],
    });
    expect(words(v)).not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
  });
});

describe("how long something has waited", () => {
  it("names yesterday, a weekday within the week, else the date", () => {
    expect(waitedWords(ist(4, 10), NOW, TZ)).toBe("waiting since yesterday");
    expect(waitedWords(ist(1, 10), NOW, TZ)).toBe("waiting since Thursday");
    expect(waitedWords("2026-09-20T04:30:00.000Z", NOW, TZ)).toBe("waiting since September 20");
  });
});
