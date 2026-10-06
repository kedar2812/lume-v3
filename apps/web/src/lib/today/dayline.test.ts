import { describe, expect, it } from "vitest";
import type { TodayView } from "@/lib/tasks/types";
import { dayline } from "./dayline";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-10-05T06:10:00Z"); // 11:40 in Kolkata
const ist = (d: number, hh: number, mm = 0) =>
  new Date(Date.UTC(2026, 9, d, hh, mm) - 330 * 60_000).toISOString();
const t = (id: string, dueAt: string) => ({
  id,
  leadId: id,
  leadName: id,
  title: "x",
  note: null,
  dueAt,
  status: "open" as const,
  remindMinutes: [],
  recurrence: null,
  assignee: { id: "me", name: "Me" },
  createdBy: null,
  doneAt: null,
  canEdit: true,
});
const base: TodayView = { overdue: [], soon: [], later: [], done: 0, total: 0, meetings: [] };

describe("the day on one line (spec: Your day)", () => {
  it("runs 8 am to 9 pm, with now placed on it", () => {
    const d = dayline(base, NOW, TZ);
    expect([d.from, d.to]).toEqual([8 * 60, 21 * 60]);
    expect(d.now).toBeCloseTo(((11 * 60 + 40 - 480) / 780) * 100, 5);
  });
  it("widens to fit anything earlier or later today", () => {
    const d = dayline(
      { ...base, later: [t("late", ist(5, 22, 30))], overdue: [t("early", ist(5, 6, 15))] },
      NOW,
      TZ,
    );
    expect([d.from, d.to]).toEqual([6 * 60, 23 * 60]);
  });
  it("marks each follow-up by where it stands; ones from before today are counted, not placed", () => {
    const v: TodayView = {
      ...base,
      overdue: [t("old", ist(3, 16)), t("late", ist(5, 11))],
      soon: [t("soon", ist(5, 12, 30))],
      later: [t("later", ist(5, 17))],
      doneToday: [{ id: "done", title: "x", dueAt: ist(5, 9), leadId: "d", leadName: "D" }],
    };
    const d = dayline(v, NOW, TZ);
    expect(d.dots.map((x) => [x.id, x.state])).toEqual([
      ["done", "done"],
      ["late", "over"],
      ["soon", "soon"],
      ["later", "later"],
    ]);
    expect(d.older.map((x) => x.id)).toEqual(["old"]);
  });
  it("places calls that still stand, done ones greyed; cancelled and moved ones aren't on the line", () => {
    const m = (id: string, at: string, status: "scheduled" | "completed" | "cancelled" | "rescheduled") => ({
      id,
      title: "Call",
      startsAt: at,
      endsAt: new Date(Date.parse(at) + 1_800_000).toISOString(),
      link: null,
      status,
      lead: { id, name: id },
      matchedBy: "calendly" as const,
      reminder: null,
    });
    const d = dayline(
      {
        ...base,
        meetings: [
          m("a", ist(5, 10), "completed"),
          m("b", ist(5, 12, 30), "scheduled"),
          m("c", ist(5, 13), "cancelled"),
          m("e", ist(5, 14), "rescheduled"),
        ],
      },
      NOW,
      TZ,
    );
    expect(d.calls.map((c) => [c.id, c.done, c.next])).toEqual([
      ["a", true, false],
      ["b", false, true],
    ]);
  });
});
