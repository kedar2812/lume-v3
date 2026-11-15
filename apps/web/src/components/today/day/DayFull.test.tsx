import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskView, TodayView, YourDay } from "@/lib/tasks/types";
import { DayFull } from "./DayFull";

type Answer = YourDay | { ok: false; status: number; code: string; message: string };
const day = vi.fn<(date: string) => Promise<Answer>>();
// The client answers { ok, data } (it never throws); a test gives the day itself, or a failed answer.
vi.mock("@/lib/tasks/client", () => ({
  tasksClient: {
    day: async (d: string) => {
      const r = await day(d);
      return "ok" in r ? r : { ok: true, status: 200, data: r };
    },
  },
}));

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-10-05T06:10:00Z"); // 11:40 am Monday, October 5, in Kolkata
const at = (hh: number, mm = 0, d = 5) => new Date(Date.UTC(2026, 9, d, hh, mm) - 330 * 60_000).toISOString();
const t = (id: string, dueAt: string, status: TaskView["status"] = "open"): TaskView => ({
  id,
  leadId: `l-${id}`,
  leadName: `Lead ${id}`,
  title: `Task ${id}`,
  note: null,
  dueAt,
  status,
  remindMinutes: [0],
  recurrence: null,
  assignee: { id: "u-me", name: "Maya Kapoor" },
  createdBy: null,
  doneAt: null,
  canEdit: true,
});
const V: TodayView = {
  overdue: [t("o", at(10))],
  soon: [],
  later: [t("l", at(18))],
  done: 0,
  total: 2,
  doneToday: [],
  meetings: [
    {
      id: "m",
      title: "Discovery call",
      startsAt: at(15),
      endsAt: at(15, 30),
      link: null,
      status: "scheduled",
      lead: { id: "l-m", name: "Isha Kapoor" },
      matchedBy: "calendar",
      reminder: null,
    },
  ],
};

/** Today with the card's expand button, opening the full screen the way Today does. */
function Page({ now = NOW, v = V }: { now?: Date; v?: TodayView }) {
  const card = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(true);
  return (
    <>
      <section ref={card} data-testid="card">
        <button type="button" aria-label="Open Your day full screen" onClick={() => setOpen(true)}>
          open
        </button>
      </section>
      {open && <DayFull v={v} now={now} tz={TZ} from={card} onClose={() => setOpen(false)} />}
    </>
  );
}
const dialog = () => screen.getByRole("dialog", { name: "Your day" });

const cw = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
beforeEach(() => {
  // jsdom lays nothing out: a 1000 px wide timeline, so Fit day has a size.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  day.mockReset();
  day.mockImplementation(() => new Promise(() => {})); // another day stays loading unless a test answers
  try {
    localStorage.clear();
  } catch {
    // some tests break storage on purpose
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  if (cw) Object.defineProperty(HTMLElement.prototype, "clientWidth", cw);
  else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});

describe("DayFull: opening and closing", () => {
  it("opens as a dialog named Your day, with today's date", () => {
    render(<Page />);
    expect(within(dialog()).getByText("October 5, Monday")).toBeTruthy();
    expect(within(dialog()).getByText("1 call · 2 follow-ups")).toBeTruthy();
  });

  it("Esc, × and the scrim each close it, and focus goes back to the expand button", async () => {
    const { unmount } = render(<Page />);
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open Your day full screen" })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Your day full screen" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open Your day full screen" }));
    fireEvent.click(document.querySelector("[data-scrim] > [aria-hidden]")!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    unmount();
  });

  it("reduced motion: it fades, it doesn't grow out of the card", () => {
    const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel() {} }) as unknown as Animation);
    Element.prototype.animate = animate;
    vi.spyOn(window, "matchMedia").mockImplementation(
      (q: string) =>
        ({
          matches: q.includes("reduce"),
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    );
    render(<Page />);
    const frames = (animate.mock.calls[0] as unknown as [Keyframe[]])[0];
    expect(frames.some((k) => "transform" in k)).toBe(false);
    expect(frames.some((k) => "opacity" in k)).toBe(true);
    delete (Element.prototype as { animate?: unknown }).animate;
  });
});

describe("DayFull: other days", () => {
  it("Previous day loads that day and shows its date; Today comes back", async () => {
    day.mockResolvedValue({ date: "2026-10-04", followUps: [t("y", at(9, 0, 4))], meetings: [] });
    render(<Page />);
    expect(within(dialog()).queryByRole("button", { name: "Today" })).toBeNull();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Previous day" }));
    expect(day).toHaveBeenCalledWith("2026-10-04");
    await waitFor(() => expect(within(dialog()).getByText("October 4, Sunday")).toBeTruthy());
    await waitFor(() => expect(within(dialog()).getByText("0 calls · 1 follow-up")).toBeTruthy());
    fireEvent.click(within(dialog()).getByRole("button", { name: "Today" }));
    expect(within(dialog()).getByText("October 5, Monday")).toBeTruthy();
    expect(within(dialog()).queryByRole("button", { name: "Today" })).toBeNull();
  });

  it("while another day loads, the last one stays, faded, as itself (no empty flash)", () => {
    render(<Page />); // the default answer never comes: the day stays loading
    fireEvent.keyDown(document, { key: "Tab" });
    fireEvent.click(within(dialog()).getByRole("radio", { name: "List" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Previous day" }));
    expect(within(dialog()).getByText("October 4, Sunday")).toBeTruthy();
    expect(within(dialog()).getByRole("status", { name: "Getting the day" })).toBeTruthy();
    expect(within(dialog()).queryByText("Nothing planned for this day")).toBeNull();
    expect(
      within(dialog())
        .getAllByRole("listitem")
        .map((r) => r.getAttribute("data-id")),
    ).toEqual(["o", "m", "l"]);
    expect(dialog().querySelector("[data-stale]")).not.toBeNull();
  });

  it("an error has Try again, and the day buttons still work", async () => {
    day.mockResolvedValueOnce({ ok: false, status: 0, code: "OFFLINE", message: "offline" });
    day.mockResolvedValueOnce({ date: "2026-10-06", followUps: [], meetings: [] });
    render(<Page />);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Next day" }));
    const again = await within(dialog()).findByRole("button", { name: "Try again" });
    expect(within(dialog()).getByRole("button", { name: "Previous day" })).toBeEnabled();
    fireEvent.click(again);
    await waitFor(() => expect(within(dialog()).getByText("Nothing planned for this day")).toBeTruthy());
  });

  it("past midnight it stays on the day it showed", () => {
    const { rerender } = render(<Page />);
    rerender(<Page now={new Date("2026-10-05T19:00:00Z")} />); // 12:30 am on the 6th in Kolkata
    expect(within(dialog()).getByText("October 5, Monday")).toBeTruthy();
  });
});

describe("DayFull: Show and view", () => {
  it("Show Calls leaves only calls, on the timeline and in the list, and the count says so", () => {
    render(<Page />);
    fireEvent.click(within(dialog()).getByRole("radio", { name: "Calls" }));
    expect(
      within(dialog())
        .getAllByRole("region")
        .map((r) => r.getAttribute("aria-label")),
    ).toEqual(["Calls"]);
    expect(within(dialog()).getByText("1 call")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("radio", { name: "List" }));
    expect(
      within(dialog())
        .getAllByRole("listitem")
        .map((r) => r.getAttribute("data-id")),
    ).toEqual(["m"]);
    expect(within(dialog()).queryByRole("button", { name: "Zoom in" })).toBeNull();
  });

  it("Timeline or List and Show are remembered; it still opens on today", async () => {
    day.mockResolvedValue({ date: "2026-10-04", followUps: [], meetings: [] });
    const { unmount } = render(<Page />);
    fireEvent.click(within(dialog()).getByRole("radio", { name: "List" }));
    fireEvent.click(within(dialog()).getByRole("radio", { name: "Follow-ups" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Previous day" }));
    await waitFor(() => expect(within(dialog()).getByText("October 4, Sunday")).toBeTruthy());
    unmount();
    render(<Page />);
    expect(within(dialog()).getByRole("radio", { name: "List" })).toHaveAttribute("aria-checked", "true");
    expect(within(dialog()).getByRole("radio", { name: "Follow-ups" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(within(dialog()).getByText("October 5, Monday")).toBeTruthy();
  });

  it("storage that throws doesn't break it", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<Page />);
    act(() => fireEvent.click(within(dialog()).getByRole("radio", { name: "List" })));
    expect(within(dialog()).getAllByRole("listitem").length).toBe(3);
  });

  it("zoom: + and − step it and Fit day goes back; the level shows", () => {
    render(<Page />);
    const level = () => within(dialog()).getByTestId("zoom-level").textContent;
    expect(level()).toBe("100%");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Zoom in" }));
    expect(level()).toBe("135%");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Zoom out" }));
    expect(level()).toBe("100%");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Zoom in" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Fit day" }));
    expect(level()).toBe("100%");
  });
});

describe("DayFull: review fixes (2026-11-15)", () => {
  /** Element.animate that the test finishes by hand: one record per animation started. */
  function animations() {
    const made: { frames: Keyframe[]; done: () => void; reversed: boolean }[] = [];
    Element.prototype.animate = function (frames: Keyframe[] | PropertyIndexedKeyframes | null) {
      let done = () => {};
      const finished = new Promise<void>((r) => (done = r));
      const rec = { frames: frames as Keyframe[], done, reversed: false };
      made.push(rec);
      return {
        finished,
        cancel() {},
        reverse() {
          rec.reversed = true;
        },
        playState: "running",
      } as unknown as Animation;
    } as typeof Element.prototype.animate;
    return made;
  }
  afterEach(() => {
    delete (Element.prototype as { animate?: unknown }).animate;
    vi.useRealTimers();
  });

  it("the dialog itself can hold focus, so Esc and Tab still work after a click on empty space", () => {
    render(<Page />);
    expect(dialog()).toHaveAttribute("tabindex", "-1");
  });

  it("its insides show about 120 ms in, not after the whole grow", async () => {
    vi.useFakeTimers();
    animations();
    render(<Page />);
    expect(dialog()).not.toHaveAttribute("data-ready");
    await act(async () => vi.advanceTimersByTime(130));
    expect(dialog()).toHaveAttribute("data-ready");
  });

  it("closed while still opening: it turns round from where it is and never fades back in", async () => {
    const made = animations();
    render(<Page />);
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(made).toHaveLength(1); // no second animation from full size
    expect(made[0]!.reversed).toBe(true);
    await act(async () => made[0]!.done());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Show Calls on a day of follow-ups only says there are no calls", () => {
    render(<Page v={{ ...V, meetings: [] }} />);
    fireEvent.click(within(dialog()).getByRole("radio", { name: "Calls" }));
    expect(within(dialog()).getByText("No calls on this day")).toBeTruthy();
    expect(within(dialog()).queryByText("Add a follow-up from any lead")).toBeNull();
  });

  it("while another day loads, the header doesn't show the last day's count", () => {
    render(<Page />);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Previous day" }));
    expect(within(dialog()).queryByText("1 call · 2 follow-ups")).toBeNull();
  });

  it("a day looked at again is fetched again (what's shown stays meanwhile)", async () => {
    day.mockResolvedValue({ date: "2026-10-04", followUps: [], meetings: [] });
    render(<Page />);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Previous day" }));
    await waitFor(() => expect(within(dialog()).getByText("Nothing planned for this day")).toBeTruthy());
    fireEvent.click(within(dialog()).getByRole("button", { name: "Today" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Previous day" }));
    await waitFor(() => expect(day).toHaveBeenCalledTimes(2));
  });
});

describe("DayFull: second review (2026-11-15)", () => {
  it("a day seen before that fails to refresh shows what it had, and says it couldn't refresh, with Try again", async () => {
    day.mockResolvedValueOnce({ date: "2026-10-04", followUps: [t("y", at(9, 0, 4))], meetings: [] });
    day.mockResolvedValueOnce({ ok: false, status: 0, code: "OFFLINE", message: "offline" });
    render(<Page />);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Previous day" }));
    await waitFor(() => expect(within(dialog()).getByText("0 calls · 1 follow-up")).toBeTruthy());
    fireEvent.click(within(dialog()).getByRole("button", { name: "Today" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Previous day" }));
    await waitFor(() => expect(within(dialog()).getByText("LUME couldn't refresh this day.")).toBeTruthy());
    expect(within(dialog()).getByText("0 calls · 1 follow-up")).toBeTruthy();
    expect(within(dialog()).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("a slow answer for a day left behind never overwrites a newer one", async () => {
    const answers: ((y: YourDay) => void)[] = [];
    day.mockImplementation(() => new Promise<YourDay>((r) => answers.push(r)));
    render(<Page />);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Previous day" })); // asks for the 4th (slow)
    fireEvent.click(within(dialog()).getByRole("button", { name: "Today" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Previous day" })); // asks again
    await act(async () =>
      answers[1]!({ date: "2026-10-04", followUps: [t("new", at(9, 0, 4))], meetings: [] }),
    );
    await act(async () => answers[0]!({ date: "2026-10-04", followUps: [], meetings: [] }));
    await waitFor(() => expect(within(dialog()).getByText("0 calls · 1 follow-up")).toBeTruthy());
  });
});
