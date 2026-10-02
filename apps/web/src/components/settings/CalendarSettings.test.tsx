import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BACK_KEY } from "@/components/calendar/CalendarGear";
import { calendarClient } from "@/lib/calendar/client";
import type { CalendarConnection } from "@/lib/calendar/types";
import { CalendarSettings } from "./CalendarSettings";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/calendar/client", () => ({
  calendarClient: {
    chooseCalendars: vi.fn(),
    disconnect: vi.fn(),
    connect: vi.fn(),
    sync: vi.fn(),
    connection: vi.fn(),
  },
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

const connected = (
  over: Partial<Extract<CalendarConnection, { connected: true }>> = {},
): CalendarConnection => ({
  available: true,
  connected: true,
  googleEmail: "maya@brightpath.test",
  status: "active",
  calendars: [
    { id: "maya@brightpath.test", name: "Maya Kapoor", chosen: true },
    { id: "sales@group.calendar.google.com", name: "Sales calls", chosen: false },
  ],
  lastSyncedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  lastSync: null,
  lastError: null,
  lastFailedAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe("Settings → Calendar", () => {
  it("says who's connected, when LUME last read it, and how often", () => {
    render(<CalendarSettings initial={connected()} calendly={null} />);
    expect(screen.getByText("maya@brightpath.test")).toBeInTheDocument();
    expect(screen.getByText(/Last synced 2 min ago · every 5 minutes/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Refresh/ })).toBeInTheDocument();
  });

  it("a calendar's switch chooses it, and rolls back with the server's words if that fails", async () => {
    vi.mocked(calendarClient.chooseCalendars).mockResolvedValueOnce(
      ok(
        connected({
          calendars: [
            { id: "maya@brightpath.test", name: "Maya Kapoor", chosen: true },
            { id: "sales@group.calendar.google.com", name: "Sales calls", chosen: true },
          ],
        }),
      ),
    );
    render(<CalendarSettings initial={connected()} calendly={null} />);
    const sales = screen.getByRole("switch", { name: "Sales calls" });
    expect(sales).toHaveAttribute("aria-checked", "false");
    await userEvent.click(sales);
    expect(calendarClient.chooseCalendars).toHaveBeenCalledWith([
      "maya@brightpath.test",
      "sales@group.calendar.google.com",
    ]);

    vi.mocked(calendarClient.chooseCalendars).mockResolvedValueOnce({
      ok: false,
      status: 503,
      code: "GOOGLE_UNAVAILABLE",
      message: "LUME couldn't reach Google. Try again in a minute.",
    });
    const mine = screen.getByRole("switch", { name: "Maya Kapoor" });
    await userEvent.click(mine);
    expect(await screen.findByRole("alert")).toHaveTextContent("LUME couldn't reach Google");
    expect(mine).toHaveAttribute("aria-checked", "true");
  });

  it("Disconnect asks first, in red, saying what goes; then connecting is offered again", async () => {
    vi.mocked(calendarClient.disconnect).mockResolvedValue(
      ok({ available: true, connected: false as const }),
    );
    render(<CalendarSettings initial={connected()} calendly={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const confirm = screen.getByRole("group", { name: "Disconnect Google Calendar" });
    expect(confirm).toHaveTextContent(/every meeting it brought/);
    expect(calendarClient.disconnect).not.toHaveBeenCalled();
    await userEvent.click(within(confirm).getByRole("button", { name: "Disconnect" }));
    expect(calendarClient.disconnect).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
  });

  it("a connection Google withdrew shows the amber bar with Connect again", () => {
    render(
      <CalendarSettings
        initial={connected({
          status: "needs_reconnect",
          lastError: "Google stopped letting LUME read your calendar.",
        })}
        calendly={null}
      />,
    );
    const bar = screen.getByRole("status", { name: "Needs reconnecting" });
    expect(bar).toHaveTextContent("Google stopped letting LUME read your calendar.");
    expect(within(bar).getByRole("button", { name: "Connect again" })).toBeInTheDocument();
  });

  it("shows the Calendly row to an admin, linking to Integrations", () => {
    render(<CalendarSettings initial={connected()} calendly={{ connected: true }} />);
    expect(screen.getByRole("link", { name: /Calendly/ })).toHaveAttribute(
      "href",
      "/settings/integrations/calendly",
    );
    expect(screen.getByText("On")).toBeInTheDocument();
  });

  it("‹ Calendar returns to the Calendar view the gear left from, and never off LUME", () => {
    sessionStorage.setItem(BACK_KEY, "/calendar?view=week&d=2026-10-08");
    const { unmount } = render(<CalendarSettings initial={connected()} calendly={null} />);
    expect(screen.getByRole("link", { name: "‹ Calendar" })).toHaveAttribute(
      "href",
      "/calendar?view=week&d=2026-10-08",
    );
    unmount();
    sessionStorage.setItem(BACK_KEY, "https://evil.example/calendar");
    render(<CalendarSettings initial={connected()} calendly={null} />);
    expect(screen.getByRole("link", { name: "‹ Calendar" })).toHaveAttribute("href", "/calendar");
  });
});
