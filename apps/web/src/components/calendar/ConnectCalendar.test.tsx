import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calendarClient } from "@/lib/calendar/client";
import { CalendarConnected, ConnectCalendar, RETURN_KEY } from "./ConnectCalendar";

const replace = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("@/lib/calendar/client", () => ({
  calendarClient: { connect: vi.fn(), complete: vi.fn(), connection: vi.fn() },
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const no = (code: string, message: string) => ({ ok: false as const, status: 400, code, message });
const assign = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  search = "";
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, pathname: "/calendar", search: "", assign },
  });
});

describe("the connect card", () => {
  it("makes three plain promises and offers Continue with Google", () => {
    render(<ConnectCalendar state="connect" admin={false} />);
    expect(screen.getByText(/Only meetings with your leads/)).toBeInTheDocument();
    expect(screen.getByText(/Personal events never leave Google/)).toBeInTheDocument();
    expect(screen.getByText(/Read-only/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Set up Calendly/ })).not.toBeInTheDocument();
  });

  it("offers Calendly to an admin", () => {
    render(<ConnectCalendar state="connect" admin />);
    expect(screen.getByRole("link", { name: /Set up Calendly/ })).toHaveAttribute(
      "href",
      "/settings/integrations/calendly",
    );
  });

  it("remembers where connecting began, then goes to Google", async () => {
    vi.mocked(calendarClient.connect).mockResolvedValue(ok({ url: "https://connect.lumecrm.in/start?i=x" }));
    render(<ConnectCalendar state="connect" admin={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(sessionStorage.getItem(RETURN_KEY)).toBe("/calendar");
    expect(assign).toHaveBeenCalledWith("https://connect.lumecrm.in/start?i=x");
  });

  it("says a refusal in LUME's words, with Try again", async () => {
    vi.mocked(calendarClient.connect).mockResolvedValue(
      no("CALENDAR_OFF", "Google Calendar is off. An admin can switch it on in Settings → Integrations."),
    );
    render(<ConnectCalendar state="connect" admin={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Google Calendar is off");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("with the module off, says who can switch it on, and offers no dead button", () => {
    render(<ConnectCalendar state="off" admin={false} />);
    expect(
      screen.getByText(/An admin can switch Google Calendar on in Settings → Integrations/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue with Google" })).not.toBeInTheDocument();
  });

  it("for a role that doesn't connect a calendar, says so and that others' meetings still show", () => {
    render(<ConnectCalendar state="noPermission" admin={false} />);
    expect(
      screen.getByText("Your role doesn't connect a calendar. Meetings others bring still show here."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue with Google" })).not.toBeInTheDocument();
  });
});

describe("back from Google", () => {
  it("completes the hand-back once and returns to where connecting began", async () => {
    search = "p=sealed&s=sig";
    sessionStorage.setItem(RETURN_KEY, "/settings/calendar");
    vi.mocked(calendarClient.complete).mockResolvedValue(
      ok({ available: true, connected: false as const }) as never,
    );
    vi.mocked(calendarClient.connection).mockResolvedValue(
      ok({
        available: true,
        connected: true as const,
        googleEmail: "maya@example.com",
        status: "active" as const,
        calendars: [],
        lastSyncedAt: "2026-10-01T10:00:00.000Z",
        lastSync: { at: "2026-10-01T10:00:00.000Z", added: 3, moved: 0, cancelled: 0, changed: 0 },
        lastError: null,
      }),
    );
    const { rerender } = render(<CalendarConnected />);
    rerender(<CalendarConnected />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/settings/calendar"), { timeout: 6000 });
    expect(calendarClient.complete).toHaveBeenCalledTimes(1);
    expect(calendarClient.complete).toHaveBeenCalledWith({ p: "sealed", s: "sig" });
  });

  it("refuses a stored path that leads off LUME, and returns to the Calendar", async () => {
    search = "p=sealed&s=sig";
    sessionStorage.setItem(RETURN_KEY, "//evil.example/steal");
    vi.mocked(calendarClient.complete).mockResolvedValue(ok({ available: true, connected: false }) as never);
    vi.mocked(calendarClient.connection).mockResolvedValue(
      ok({ available: true, connected: false }) as never,
    );
    render(<CalendarConnected />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/calendar"), { timeout: 6000 });
  });

  it("says the server's words when the hand-back is refused, with Try again", async () => {
    search = "p=sealed&s=sig";
    vi.mocked(calendarClient.complete).mockResolvedValue(
      no("CONNECT_EXPIRED", "This connection took too long. Try connecting your calendar again."),
    );
    render(<CalendarConnected />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This connection took too long");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
