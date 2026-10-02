import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Meeting } from "@/lib/calendar/types";
import { MeetingsTab } from "./MeetingsTab";
import { NextMeeting } from "./NextMeeting";

const TZ = "Asia/Dubai";
const at = (local: string) => {
  const [d, t] = local.split(" ") as [string, string];
  const [y, mo, da] = d.split("-").map(Number) as [number, number, number];
  const [h, mi] = t.split(":").map(Number) as [number, number];
  return new Date(Date.UTC(y, mo - 1, da, h - 4, mi));
};
const meet = (id: string, local: string, over: Partial<Meeting> = {}): Meeting => {
  const start = at(local);
  return {
    id,
    title: "Discovery call",
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
    status: "scheduled",
    link: `https://meet.google.com/${id}`,
    location: null,
    ownerId: "u1",
    matchedBy: "calendly",
    outcomeNote: null,
    lead: { id: "l1", name: "Dana Whitfield", pipelineId: "p1", stageId: "s1" },
    ...over,
  };
};
const NOW = at("2026-10-01 14:16");

describe("the drawer's next meeting", () => {
  it("about to start: amber 'in 14 min', a countdown, Join first and Open in Calendar", () => {
    render(<NextMeeting meetings={[meet("soon", "2026-10-01 14:30")]} tz={TZ} now={NOW} />);
    const card = screen.getByRole("region", { name: "Next meeting" });
    expect(card).toHaveAttribute("data-soon", "true");
    expect(card).toHaveTextContent("Next meeting · Today");
    expect(card).toHaveTextContent("in 14 min");
    expect(card).toHaveTextContent("Discovery call, 2:30 – 3 pm");
    expect(card).toHaveTextContent("Booked through Calendly");
    expect(within(card).getByRole("link", { name: "Join" })).toHaveAttribute(
      "href",
      "https://meet.google.com/soon",
    );
    expect(within(card).getByRole("link", { name: "Open in Calendar" })).toHaveAttribute(
      "href",
      "/calendar?d=2026-10-01&m=soon",
    );
  });

  it("further off: its day in words and its time, no amber", () => {
    render(<NextMeeting meetings={[meet("later", "2026-10-02 10:30")]} tz={TZ} now={NOW} />);
    const card = screen.getByRole("region", { name: "Next meeting" });
    expect(card).not.toHaveAttribute("data-soon");
    expect(card).toHaveTextContent("Next meeting · Tomorrow");
    expect(card).toHaveTextContent("Discovery call, 10:30 – 11 am");
  });

  it("nothing to come: no card (past and cancelled ones don't count)", () => {
    const { container } = render(
      <NextMeeting
        meetings={[
          meet("past", "2026-10-01 09:00"),
          meet("off", "2026-10-02 10:00", { status: "cancelled" }),
        ]}
        tz={TZ}
        now={NOW}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("the drawer's Meetings tab", () => {
  const MEETINGS = [
    meet("held", "2026-09-28 11:00", { status: "completed", outcomeNote: "Wants the annual plan" }),
    meet("owed", "2026-10-01 09:00"),
    meet("next", "2026-10-02 10:30"),
    meet("off", "2026-09-29 10:00", { status: "cancelled" }),
  ];

  it("coming up first, then earlier ones newest first, each with how it went", () => {
    render(<MeetingsTab meetings={MEETINGS} tz={TZ} now={NOW} onLogOutcome={vi.fn()} />);
    const up = screen.getByRole("list", { name: "Coming up" });
    expect(within(up).getAllByRole("listitem")).toHaveLength(1);
    const earlier = screen.getByRole("list", { name: "Earlier" });
    const rows = within(earlier).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-id"))).toEqual(["owed", "off", "held"]);
    expect(within(rows[2]!).getByText("Held")).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent("Wants the annual plan");
    expect(within(rows[1]!).getByText("Cancelled")).toBeInTheDocument();
  });

  it("an ended meeting with no outcome offers Log outcome", async () => {
    const onLogOutcome = vi.fn();
    render(<MeetingsTab meetings={MEETINGS} tz={TZ} now={NOW} onLogOutcome={onLogOutcome} />);
    await userEvent.click(screen.getByRole("button", { name: "Log outcome" }));
    expect(onLogOutcome).toHaveBeenCalledWith(MEETINGS[1]);
  });

  it("Review: no Log outcome on a colleague's call this person can't record (the server would refuse it)", () => {
    const theirs = meet("theirs", "2026-10-01 09:00", { ownerId: "u-other" });
    render(
      <MeetingsTab
        meetings={[theirs]}
        tz={TZ}
        now={NOW}
        onLogOutcome={vi.fn()}
        canLog={(m) => m.ownerId === "u1"}
      />,
    );
    expect(screen.getByRole("list", { name: "Earlier" })).toHaveTextContent("Discovery call");
    expect(screen.queryByRole("button", { name: "Log outcome" })).not.toBeInTheDocument();
  });

  it("none yet: says so plainly", () => {
    render(<MeetingsTab meetings={[]} tz={TZ} now={NOW} onLogOutcome={vi.fn()} />);
    expect(screen.getByText("No meetings with this lead yet.")).toBeInTheDocument();
  });
});
