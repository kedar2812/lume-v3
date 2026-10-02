import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TodayMeeting } from "@/lib/tasks/types";
import { TodayCalls, callsBrief } from "./TodayCalls";

const TZ = "Asia/Dubai";
/** An instant on the business's clock: "2026-10-01 14:30". */
const at = (local: string) => {
  const [d, t] = local.split(" ") as [string, string];
  const [y, mo, da] = d.split("-").map(Number) as [number, number, number];
  const [h, mi] = t.split(":").map(Number) as [number, number];
  return new Date(Date.UTC(y, mo - 1, da, h - 4, mi));
};
const call = (id: string, local: string, over: Partial<TodayMeeting> = {}): TodayMeeting => {
  const start = at(local);
  return {
    id,
    title: "Discovery call",
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
    link: `https://meet.google.com/${id}`,
    status: "scheduled",
    lead: { id: `l-${id}`, name: "Dana Whitfield" },
    matchedBy: "attendee",
    reminder: null,
    ...over,
  };
};
const NOW = at("2026-10-01 14:15");
const CALLS = [
  call("held", "2026-10-01 09:00", { status: "completed", lead: { id: "l1", name: "Priya Menon" } }),
  call("owed", "2026-10-01 11:30", { title: "Pricing walkthrough", lead: { id: "l2", name: "Karim Aziz" } }),
  call("soon", "2026-10-01 14:30", {
    matchedBy: "calendly",
    reminder: { at: at("2026-10-01 12:30").toISOString(), sent: true },
  }),
  call("later", "2026-10-01 16:00", {
    title: "Check-in",
    lead: { id: "l4", name: "Aisha Khan" },
    reminder: { at: at("2026-10-01 14:00").toISOString(), sent: false },
  }),
];

describe("Today's calls", () => {
  it("lists the day's calls with their time, length, person, title and where they came from", () => {
    render(<TodayCalls meetings={CALLS} tz={TZ} now={NOW} />);
    const card = screen.getByRole("region", { name: "Today's calls" });
    expect(card).toHaveTextContent("4 · 2 to come");
    expect(within(card).getByRole("link", { name: /Calendar/ })).toHaveAttribute("href", "/calendar");
    const soon = within(card).getByRole("group", { name: /Dana Whitfield/ });
    expect(soon).toHaveTextContent("2:30 pm");
    expect(soon).toHaveTextContent("30 min");
    expect(soon).toHaveTextContent("Booked through Calendly");
    expect(within(card).getByRole("group", { name: /Karim Aziz/ })).toHaveTextContent("Google Calendar");
  });

  it("says each state: Held, Log outcome, in 15 min with Join, and the reminder", () => {
    const onLogOutcome = vi.fn();
    render(<TodayCalls meetings={CALLS} tz={TZ} now={NOW} onLogOutcome={onLogOutcome} />);
    expect(within(screen.getByRole("group", { name: /Priya Menon/ })).getByText("Held")).toBeInTheDocument();
    within(screen.getByRole("group", { name: /Karim Aziz/ }))
      .getByRole("button", { name: "Log outcome" })
      .click();
    expect(onLogOutcome).toHaveBeenCalledWith(CALLS[1]);
    const soon = screen.getByRole("group", { name: /Dana Whitfield/ });
    expect(soon).toHaveAttribute("data-state", "soon");
    expect(within(soon).getByText("in 15 min")).toBeInTheDocument();
    expect(within(soon).getByRole("link", { name: "Join" })).toHaveAttribute(
      "href",
      "https://meet.google.com/soon",
    );
    expect(soon).toHaveTextContent("reminder sent 12:30 pm");
    expect(screen.getByRole("group", { name: /Aisha Khan/ })).toHaveTextContent("reminder at 2 pm");
  });

  it("shows nothing when there are no calls today", () => {
    const { container } = render(<TodayCalls meetings={[]} tz={TZ} now={NOW} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("the brief line", () => {
  it("names the next call, and the calls still owed their outcome", () => {
    expect(callsBrief(CALLS, NOW, TZ)).toBe(
      "Your call with Dana is in 15 minutes. One call from earlier still needs its outcome.",
    );
  });

  it("a later call is said by its time; nothing to say without calls", () => {
    expect(callsBrief([CALLS[3]!], NOW, TZ)).toBe("Your call with Aisha is at 4 pm.");
    // A real event's title, as Google has it, is never bent into the sentence.
    expect(callsBrief([{ ...CALLS[3]!, title: "Dana Whitfield and Kedar" }], NOW, TZ)).toBe(
      "Your call with Aisha is at 4 pm.",
    );
    // Not with a lead: the title, as it is.
    expect(callsBrief([{ ...CALLS[3]!, lead: null, title: "Q3 Planning" }], NOW, TZ)).toBe(
      "Q3 Planning is at 4 pm.",
    );
    expect(callsBrief([], NOW, TZ)).toBeNull();
    expect(callsBrief([CALLS[0]!], NOW, TZ)).toBeNull(); // held already: nothing to say
  });
});
