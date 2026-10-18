import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskView, TodayView } from "@/lib/tasks/types";
import { DayTile } from "./DayTile";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-10-05T06:10:00Z"); // 11:40 am in Kolkata
const at = (hh: number, mm = 0) => new Date(Date.UTC(2026, 9, 5, hh, mm) - 330 * 60_000).toISOString();
const t = (id: string, leadName: string, dueAt: string): TaskView => ({
  id,
  leadId: `l-${id}`,
  leadName,
  title: "Follow up",
  note: null,
  dueAt,
  status: "open",
  remindMinutes: [0],
  recurrence: null,
  assignee: { id: "u-me", name: "Maya Kapoor" },
  createdBy: null,
  doneAt: null,
  canEdit: true,
});

// jsdom lays nothing out: give the day line the width a desktop Today has.
const width = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!;
beforeEach(() =>
  Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get: () => 600 }),
);
afterEach(() => Object.defineProperty(Element.prototype, "clientWidth", width));

describe("Your day: follow-ups at about the same time (axe target-size)", () => {
  it("three at 10 am share one marker with their count, opening the one that needs you most; one at 4 pm keeps its dot", () => {
    const v: TodayView = {
      overdue: [t("b", "Omar Ali", at(10))],
      soon: [],
      later: [t("d", "Sara Pinto", at(16))],
      doneToday: [t("a", "Aisha Khan", at(10)), t("c", "Ravi Rao", at(10, 2))],
      done: 2,
      total: 4,
    } as TodayView;
    render(<DayTile v={v} now={NOW} tz={TZ} />);
    const group = screen.getByRole("link", { name: /^3 follow-ups: / });
    expect(group).toHaveTextContent("3");
    expect(group).toHaveAttribute("href", "/leads?lead=l-b");
    expect(group).toHaveAccessibleName(expect.stringContaining("Omar Ali, 10 am, overdue"));
    expect(group).toHaveAccessibleName(expect.stringContaining("Ravi Rao, 10:02 am, done"));
    expect(
      screen.getByRole("link", { name: "Follow up, Sara Pinto, 4 pm, later today" }),
    ).toBeInTheDocument();
  });
});
