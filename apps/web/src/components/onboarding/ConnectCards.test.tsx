import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calendarClient } from "@/lib/calendar/client";
import { RETURN_KEY } from "@/components/calendar/ConnectCalendar";
import { ConnectCards } from "./ConnectCards";

vi.mock("@/lib/calendar/client", () => ({ calendarClient: { connect: vi.fn() } }));

describe("onboarding's Connect cards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it("Google Calendar's Connect goes to Google from here and comes back to onboarding (2026-10-31)", async () => {
    // It linked to /calendar, which onboarding sends back to /welcome: Connect did nothing.
    const assign = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, pathname: "/welcome", assign } });
    vi.mocked(calendarClient.connect).mockResolvedValue({ ok: true, status: 200, data: { url: "https://connect.lumecrm.in/start?x" } } as never);
    render(<ConnectCards calendar sheets={false} />);
    await userEvent.click(screen.getByRole("button", { name: /connect/i }));
    expect(calendarClient.connect).toHaveBeenCalled();
    expect(sessionStorage.getItem(RETURN_KEY)).toBe("/welcome");
    expect(assign).toHaveBeenCalledWith("https://connect.lumecrm.in/start?x");
  });

  it("Calendar off on this server: said in words, nowhere to bounce to", async () => {
    vi.mocked(calendarClient.connect).mockResolvedValue({
      ok: false,
      status: 400,
      message: "Google Calendar is off. An admin can switch Google Calendar on in Settings → Integrations.",
    } as never);
    render(<ConnectCards calendar sheets={false} />);
    await userEvent.click(screen.getByRole("button", { name: /connect/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Google Calendar is off.");
  });

  it("Google Sheets says where it's set up, with no button onboarding would bounce (2026-10-31)", () => {
    // Set up led to Integrations, which onboarding sends back to /welcome.
    render(<ConnectCards calendar={false} sheets />);
    expect(screen.getByText("After setup, in Settings → Integrations")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows no card for what this build doesn't have", () => {
    render(<ConnectCards calendar={false} sheets={false} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
