import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calendarClient } from "@/lib/calendar/client";
import type { CalendlyView } from "@/lib/calendar/types";
import { CalendlyCard } from "./CalendlyCard";
import { GoogleCalendarCard } from "./GoogleCalendarCard";

vi.mock("@/lib/calendar/client", () => ({
  calendarClient: {
    calendly: vi.fn(),
    connectCalendly: vi.fn(),
    patchCalendly: vi.fn(),
    disconnectCalendly: vi.fn(),
    setEnabled: vi.fn(),
  },
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const connected = (over: Partial<Extract<CalendlyView, { connected: true }>> = {}): CalendlyView => ({
  connected: true,
  account: { name: "Brightpath Studio", email: "bookings@brightpath.example" },
  scope: "organization",
  status: "active",
  settings: { createLeads: true, rescheduleFollowUp: true, phoneQuestion: null },
  lastEventAt: null,
  lastError: null,
  runAs: { id: "u1", name: "Maya Kapoor" },
  ...over,
});
const TOKEN = "eyJraWQiOiJzZWNyZXQtdG9rZW4tMTIzIn0";

beforeEach(() => vi.clearAllMocks());

describe("Calendly in Integrations", () => {
  it("not connected: the story, where to make a token, and that it's kept sealed", () => {
    render(<CalendlyCard initial={{ connected: false }} />);
    expect(screen.getByText("Someone books")).toBeInTheDocument();
    expect(screen.getByText("Lead found or made")).toBeInTheDocument();
    expect(screen.getByText(/Moved to its booking stage/)).toBeInTheDocument();
    expect(screen.getByLabelText("Calendly personal access token")).toBeInTheDocument();
    expect(screen.getByText(/Personal access tokens/)).toBeInTheDocument();
    expect(screen.getByText("Kept sealed; never shown again")).toBeInTheDocument();
  });

  it("connecting ticks the three checks in order, then shows it Receiving", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(calendarClient.connectCalendly).mockResolvedValue(ok(connected()));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CalendlyCard initial={{ connected: false }} />);
    await user.type(screen.getByLabelText("Calendly personal access token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "Connect Calendly" }));
    expect(calendarClient.connectCalendly).toHaveBeenCalledWith(TOKEN);
    const checks = screen.getByRole("list", { name: "Connecting Calendly" });
    expect(within(checks).getByText(/Token accepted · Brightpath Studio/)).toBeInTheDocument();
    await act(async () => void (await vi.advanceTimersByTimeAsync(2600)));
    expect(await screen.findByText("Receiving")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TOKEN);
    vi.useRealTimers();
  });

  it("shows Calendly's refusal in LUME's words, never the token", async () => {
    vi.mocked(calendarClient.connectCalendly).mockResolvedValue({
      ok: false,
      status: 409,
      code: "CALENDLY_PLAN",
      message: "Calendly sends bookings to other apps only on its Standard plan or higher.",
    });
    render(<CalendlyCard initial={{ connected: false }} />);
    await userEvent.type(screen.getByLabelText("Calendly personal access token"), TOKEN);
    await userEvent.click(screen.getByRole("button", { name: "Connect Calendly" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Standard plan or higher");
    expect(screen.getByRole("alert").textContent).not.toContain(TOKEN);
  });

  it("connected: green switches patch the settings, and the booking stage links to the pipeline", async () => {
    vi.mocked(calendarClient.patchCalendly).mockResolvedValue(
      ok(connected({ settings: { createLeads: false, rescheduleFollowUp: true, phoneQuestion: null } })),
    );
    render(<CalendlyCard initial={connected()} />);
    await userEvent.click(screen.getByRole("switch", { name: "Make a lead for someone new" }));
    expect(calendarClient.patchCalendly).toHaveBeenCalledWith({ createLeads: false });
    expect(screen.getByRole("switch", { name: "Make a lead for someone new" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("link", { name: /Booked leads move to/ })).toHaveAttribute(
      "href",
      "/settings/pipeline",
    );
  });

  it("needs attention says the server's words", () => {
    render(
      <CalendlyCard
        initial={connected({ status: "needs_attention", lastError: "Calendly stopped sending bookings." })}
      />,
    );
    expect(screen.getByRole("status", { name: "Needs attention" })).toHaveTextContent(
      "Calendly stopped sending bookings.",
    );
  });

  it("Disconnect asks first", async () => {
    vi.mocked(calendarClient.disconnectCalendly).mockResolvedValue(ok({ connected: false as const }));
    render(<CalendlyCard initial={connected()} />);
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const ask = screen.getByRole("group", { name: "Disconnect Calendly" });
    await userEvent.click(within(ask).getByRole("button", { name: "Disconnect" }));
    expect(calendarClient.disconnectCalendly).toHaveBeenCalledTimes(1);
    expect(await screen.findByLabelText("Calendly personal access token")).toBeInTheDocument();
  });
});

describe("Google Calendar in Integrations", () => {
  it("is one switch, green when on; set up, it says what it does", async () => {
    vi.mocked(calendarClient.setEnabled).mockResolvedValue(
      ok({
        googleSheets: { enabled: false, available: false, email: null, connectWithGoogle: false },
        webhooks: { enabled: false, manychat: false },
        googleCalendar: { enabled: true, available: true },
        calendly: { connected: false },
      }),
    );
    const onView = vi.fn();
    render(<GoogleCalendarCard googleCalendar={{ enabled: false, available: true }} onView={onView} />);
    await userEvent.click(screen.getByRole("switch", { name: "Google Calendar" }));
    expect(calendarClient.setEnabled).toHaveBeenCalledWith(true);
    expect(onView).toHaveBeenCalled();
  });

  it("not set up on this server, it says so and offers no switch", () => {
    render(<GoogleCalendarCard googleCalendar={{ enabled: false, available: false }} onView={vi.fn()} />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(
      screen.getByText(/comes through Connect with Google, which isn't set up on this server yet/),
    ).toBeInTheDocument();
  });
});
