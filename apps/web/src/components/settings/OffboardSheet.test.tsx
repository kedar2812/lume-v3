import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { OffboardOutcome, OffboardPreview } from "@/lib/settings/people";
import { OffboardSheet, sharesFor } from "./OffboardSheet";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

const preview = (over: Partial<OffboardPreview> = {}): OffboardPreview => ({
  person: { id: "u-rory", name: "Rory Reid", status: "active" },
  sessions: 2,
  leads: { total: 5, open: 4 },
  teams: [
    {
      id: "t-sales",
      name: "Sales",
      members: [
        { id: "u-sam", name: "Sam Okafor", openLeads: 2 },
        { id: "u-priya", name: "Priya Lal", openLeads: 0 },
      ],
    },
    { id: "t-ops", name: "Ops", members: [{ id: "u-dev", name: "Dev Rao", openLeads: 1 }] },
  ],
  people: [
    { id: "u-dev", name: "Dev Rao" },
    { id: "u-priya", name: "Priya Lal" },
    { id: "u-sam", name: "Sam Okafor" },
  ],
  calendar: { email: "rory@calendar.test", upcoming: 9 },
  last30: {
    reveals: 96,
    leadsOpened: 1240,
    exports: 0,
    alerts: 1,
    busiest: { day: "2026-10-01", count: 34 },
    usualPerDay: 3.6,
  },
  ...over,
});
const outcome = (over: Partial<OffboardOutcome> = {}): OffboardOutcome => ({
  sessions: 2,
  leads: {
    to: "team",
    moved: 5,
    shares: [
      { id: "u-priya", name: "Priya Lal", count: 4 },
      { id: "u-sam", name: "Sam Okafor", count: 1 },
    ],
  },
  calendar: { meetingsMoved: 9, meetingsRemoved: 1 },
  ...over,
});
const props = { personId: "u-rory", timeZone: "Asia/Dubai", onClose: vi.fn(), onDone: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.get).mockResolvedValue(ok(preview()));
});
afterEach(() => vi.useRealTimers());

async function open(p = props) {
  render(<OffboardSheet {...p} />);
  return screen.findByRole("dialog", { name: "Offboard Rory Reid" });
}

describe("the Offboard sheet (6C Task 2)", () => {
  it("says what offboarding will do, step by step, in LUME's words", async () => {
    const sheet = await open();
    expect(api.get).toHaveBeenCalledWith("/api/v1/users/u-rory/offboarding");
    expect(sheet).toHaveTextContent("Rory won’t be able to sign in. You can bring them back later.");
    expect(sheet).toHaveTextContent("Sign Rory out everywhere");
    expect(sheet).toHaveTextContent("2 live sessions");
    expect(sheet).toHaveTextContent("Hand on Rory’s 5 leads");
    expect(sheet).toHaveTextContent("Share them across the Sales team");
    expect(sheet).toHaveTextContent("Whoever has the fewest open leads gets the next one");
    expect(sheet).toHaveTextContent("Disconnect Rory’s Google Calendar");
    expect(sheet).toHaveTextContent("rory@calendar.test · LUME stops reading it at once");
    expect(sheet).toHaveTextContent("Rory’s last 30 days");
    const figures = within(screen.getByRole("list", { name: "Rory’s last 30 days" }));
    expect(figures.getByText("96").parentElement).toHaveTextContent("contacts opened");
    expect(figures.getByText("1,240").parentElement).toHaveTextContent("leads opened");
    expect(sheet).toHaveTextContent("Busiest day: October 1, Thursday, 34 contacts. Usually about 4 a day.");
    expect(screen.getByRole("link", { name: "Open Rory’s audit log" })).toHaveAttribute(
      "href",
      "/settings/audit?actor=u-rory",
    );
    expect(screen.getByRole("button", { name: "Offboard Rory" })).toBeInTheDocument();
  });

  it("previews each colleague's share live, the same way LUME shares them", async () => {
    await open();
    // Sam has 2 open, Priya 0: of 5, Priya takes 4 and Sam 1 (each to the fewest; ties go by name).
    expect(screen.getByText("Priya Lal · 4")).toBeInTheDocument();
    expect(screen.getByText("Sam Okafor · 1")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Team" }), "t-ops");
    expect(screen.getByText("Dev Rao · 5")).toBeInTheDocument();
    expect(sharesFor([{ id: "a", name: "A", openLeads: 0 }], 0)).toEqual([]);
  });

  it("sends each hand-on choice as LUME expects it", async () => {
    vi.mocked(api.post).mockResolvedValue(ok(outcome()));
    await open();
    await userEvent.click(screen.getByRole("radio", { name: /Give them all to one person/ }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Person" }), "u-dev");
    await userEvent.click(screen.getByRole("button", { name: "Offboard Rory" }));
    expect(api.post).toHaveBeenLastCalledWith("/api/v1/users/u-rory/offboard", {
      leads: { to: "person", userId: "u-dev" },
    });
  });

  it("leaves them unassigned, or shares across the team picked", async () => {
    vi.mocked(api.post).mockResolvedValue(ok(outcome()));
    await open();
    await userEvent.click(screen.getByRole("radio", { name: /Leave them unassigned/ }));
    await userEvent.click(screen.getByRole("button", { name: "Offboard Rory" }));
    expect(api.post).toHaveBeenLastCalledWith("/api/v1/users/u-rory/offboard", { leads: { to: "none" } });
  });

  it("ticks each step in order with its result, then says it's done; it can't be closed mid-run", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.post).mockResolvedValue(ok(outcome()));
    const onClose = vi.fn();
    const onDone = vi.fn();
    await open({ ...props, onClose, onDone });
    await userEvent.click(screen.getByRole("button", { name: "Offboard Rory" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    // Mid-run: Escape does nothing.
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    const sheet = screen.getByRole("dialog");
    expect(sheet).toHaveTextContent("Done · 2 sessions ended");
    expect(sheet).toHaveTextContent("Done · 5 leads shared: Priya 4, Sam 1");
    expect(sheet).toHaveTextContent("Done · 9 meetings went with their leads");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Rory Reid is offboarded. LUME recorded every step.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalledWith(outcome());
  });

  it("says plainly when there's nothing to hand on and nobody signed in", async () => {
    vi.mocked(api.get).mockResolvedValue(
      ok(preview({ sessions: 0, leads: { total: 0, open: 0 }, calendar: null })),
    );
    const sheet = await open();
    expect(sheet).toHaveTextContent("Already signed out");
    expect(sheet).toHaveTextContent("Rory has no leads to hand on");
    expect(sheet).not.toHaveTextContent("Google Calendar");
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("says why it can't, in LUME's words, and can still be cancelled", async () => {
    vi.mocked(api.post).mockResolvedValue({
      ok: false,
      status: 409,
      code: "NOT_ACTIVE",
      message: "Rory Reid is already disabled",
    } as never);
    const onClose = vi.fn();
    await open({ ...props, onClose });
    await userEvent.click(screen.getByRole("button", { name: "Offboard Rory" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Rory Reid is already disabled");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
