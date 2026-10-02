import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calendarClient } from "@/lib/calendar/client";
import type { Meeting } from "@/lib/calendar/types";
import { CalendarScreen, type CalendarScreenProps } from "./CalendarScreen";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/calendar",
}));
vi.mock("@/lib/calendar/client", () => ({ calendarClient: { meetings: vi.fn() } }));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const TZ = "Asia/Dubai";
/** An instant on the business's clock: "2026-10-01 14:30". */
const at = (local: string) => {
  const [d, t] = local.split(" ") as [string, string];
  const [y, mo, da] = d.split("-").map(Number) as [number, number, number];
  const [h, mi] = t.split(":").map(Number) as [number, number];
  return new Date(Date.UTC(y, mo - 1, da, h - 4, mi));
};
function meet(id: string, local: string, over: Partial<Meeting> = {}): Meeting {
  const start = at(local);
  return {
    id,
    title: `Discovery call ${id}`,
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
    status: "scheduled",
    link: `https://meet.google.com/${id}`,
    location: null,
    ownerId: "u-maya",
    matchedBy: "attendee",
    outcomeNote: null,
    lead: { id: `l-${id}`, name: `Lead ${id}`, pipelineId: "p1", stageId: "s-booked" },
    ...over,
  };
}
const MEETINGS = [
  meet("a", "2026-10-01 09:00"),
  meet("b", "2026-10-01 14:30"),
  meet("r", "2026-10-01 16:00", { ownerId: "u-ravi" }),
  meet("w", "2026-10-02 10:30", { lead: { id: "l-w", name: "Lead w", pipelineId: "p1", stageId: "s-won" } }),
];

function view(over: Partial<CalendarScreenProps> = {}) {
  const props: CalendarScreenProps = {
    me: "u-maya",
    tz: TZ,
    weekStart: "monday",
    everyone: true,
    people: [
      { id: "u-maya", name: "Maya Kapoor" },
      { id: "u-ravi", name: "Ravi Menon" },
    ],
    stages: [
      { id: "s-booked", name: "Call booked", color: "accent" },
      { id: "s-won", name: "Won", color: "ok" },
    ],
    initial: { view: "agenda", day: null, meeting: null },
    now: () => at("2026-10-01 14:16"),
    ...over,
  };
  return render(<CalendarScreen {...props} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/calendar");
  vi.mocked(calendarClient.meetings).mockResolvedValue(ok({ meetings: MEETINGS }));
});

describe("the Calendar page: the agenda", () => {
  it("groups the days in the date rule and lists each day's meetings in order", async () => {
    view();
    const today = await screen.findByRole("region", { name: "Today · October 1, Thursday" });
    expect(
      within(today)
        .getAllByRole("button", { name: /^Discovery call/ })
        .map((b) => b.textContent),
    ).toEqual([
      expect.stringContaining("Discovery call a"),
      expect.stringContaining("Discovery call b"),
      expect.stringContaining("Discovery call r"),
    ]);
    expect(screen.getByRole("region", { name: "Tomorrow · October 2, Friday" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("October 1, Thursday");
  });

  it("marks the meeting starting within 15 minutes, with Join as the main action", async () => {
    view();
    const row = await screen.findByRole("group", { name: /Discovery call b/ });
    expect(row).toHaveAttribute("data-state", "soon");
    expect(within(row).getByText("in 14 min")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "Join" })).toHaveAttribute(
      "href",
      "https://meet.google.com/b",
    );
  });

  it("an ended meeting with no outcome asks for it", async () => {
    view({ now: () => at("2026-10-01 10:00") });
    const row = await screen.findByRole("group", { name: /Discovery call a/ });
    expect(row).toHaveAttribute("data-state", "needsOutcome");
    expect(within(row).getByRole("button", { name: "Log outcome" })).toBeInTheDocument();
  });
});

describe("the Calendar page: whose and which", () => {
  it("Mine hides other people's meetings", async () => {
    view();
    await screen.findByRole("group", { name: /Discovery call r/ });
    await userEvent.click(screen.getByRole("radio", { name: "Mine" }));
    expect(screen.queryByRole("group", { name: /Discovery call r/ })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Discovery call a/ })).toBeInTheDocument();
  });

  it("offers no Everyone to a person who sees only their own", async () => {
    view({ everyone: false });
    await screen.findByRole("group", { name: /Discovery call a/ });
    expect(screen.queryByRole("radio", { name: "Everyone" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Mine" })).not.toBeInTheDocument();
  });

  it("the stage menu keeps only meetings whose lead is in it", async () => {
    view();
    await screen.findByRole("group", { name: /Discovery call a/ });
    await userEvent.click(screen.getByRole("button", { name: "Any stage" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Won" }));
    expect(screen.queryByRole("group", { name: /Discovery call a/ })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Discovery call w/ })).toBeInTheDocument();
  });
});

describe("the Calendar page: the week, the address and the drawer", () => {
  it("the week shows a meeting in its day's column", async () => {
    view({ initial: { view: "week", day: "2026-10-01", meeting: null } });
    const thursday = await screen.findByRole("group", { name: "Thursday, October 1" });
    expect(within(thursday).getByRole("button", { name: /Discovery call b/ })).toBeInTheDocument();
  });

  it("the address follows the view, the day and the open meeting, and opens them again", async () => {
    const { unmount } = view();
    await userEvent.click(await screen.findByRole("radio", { name: "Week" }));
    await userEvent.click(screen.getByRole("button", { name: /Discovery call b/ }));
    // Today's date stays out of the address, so the same link opens on today tomorrow too.
    expect(window.location.search).toBe("?view=week&m=b");
    await userEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(window.location.search).toBe("?view=week&d=2026-10-08&m=b");
    unmount();
    view({ initial: { view: "week", day: "2026-10-01", meeting: "b" } });
    expect(await screen.findByRole("dialog", { name: "Discovery call b" })).toBeInTheDocument();
  });

  it("Esc closes the menu first, then the drawer", async () => {
    view({ initial: { view: "agenda", day: null, meeting: "b" } });
    const drawer = await screen.findByRole("dialog", { name: "Discovery call b" });
    await userEvent.click(within(drawer).getByRole("button", { name: "More" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument()); // after its exit
    expect(screen.getByRole("dialog", { name: "Discovery call b" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Discovery call b" })).not.toBeInTheDocument(),
    );
  });

  it("Copy link says it copied", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    view({ initial: { view: "agenda", day: null, meeting: "b" } });
    const drawer = await screen.findByRole("dialog", { name: "Discovery call b" });
    await userEvent.click(within(drawer).getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith("https://meet.google.com/b");
    expect(within(drawer).getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("T goes to today and the arrows move the day", async () => {
    view({ initial: { view: "agenda", day: "2026-10-05", meeting: null } });
    await screen.findByRole("heading", { level: 1, name: /October 5, Monday/ });
    await act(async () => void (await userEvent.keyboard("t")));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("October 1, Thursday");
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("October 2, Friday");
  });
});

describe("the Calendar page: connecting", () => {
  it("with nothing to show, the connect card sits over a faded agenda", async () => {
    vi.mocked(calendarClient.meetings).mockResolvedValue(ok({ meetings: [] }));
    view({ connect: { state: "connect", admin: false } });
    expect(await screen.findByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
    expect(screen.getByTestId("ghost-agenda")).toHaveAttribute("aria-hidden", "true");
  });

  it("with meetings already there (Calendly's), connecting is one row above them", async () => {
    view({ connect: { state: "connect", admin: false } });
    expect(await screen.findByRole("group", { name: /Discovery call a/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
    expect(screen.queryByTestId("ghost-agenda")).not.toBeInTheDocument();
  });

  it("a role that doesn't connect still sees the agenda, with a plain line", async () => {
    view({ connect: { state: "noPermission", admin: false } });
    expect(await screen.findByRole("group", { name: /Discovery call a/ })).toBeInTheDocument();
    expect(screen.getByText(/Your role doesn't connect a calendar/)).toBeInTheDocument();
  });
});

describe("the Calendar page on a phone (5D Task 12)", () => {
  it("under 700 px: the phone's list and its sheet, never the bar, the agenda or the drawer", async () => {
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      ...real(q),
      matches: q === "(max-width: 699px)",
    })) as typeof window.matchMedia;
    try {
      view({ initial: { view: "agenda", day: null, meeting: "b" } });
      expect(await screen.findByRole("region", { name: "Today" })).toBeInTheDocument();
      expect(screen.queryByRole("radiogroup", { name: "View" })).not.toBeInTheDocument();
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(screen.getByRole("dialog", { name: "Lead b" })).toBeInTheDocument();
    } finally {
      window.matchMedia = real;
    }
  });

  it("under 700 px, a notice about connecting sits under the title, not above it", async () => {
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      ...real(q),
      matches: q === "(max-width: 699px)",
    })) as typeof window.matchMedia;
    try {
      view({ connect: { state: "unavailable", admin: true } });
      const title = await screen.findByRole("heading", { level: 1, name: "Calendar" });
      const notice = screen.getByText(/isn't set up on this server yet/);
      expect(title.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    } finally {
      window.matchMedia = real;
    }
  });
});
