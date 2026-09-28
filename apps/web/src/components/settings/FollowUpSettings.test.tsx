import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { FollowUpSettings } from "./FollowUpSettings";
import { MyAlerts } from "./MyAlerts";

vi.mock("@/lib/api", () => ({ api: { put: vi.fn(), patch: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

beforeEach(() => vi.clearAllMocks());

describe("Settings → Follow-ups (3B Task 6)", () => {
  it("escalation: a switch and after how many hours, saved together", async () => {
    vi.mocked(api.put).mockResolvedValue(ok({ escalation: { enabled: true, hours: 6 } }));
    render(<FollowUpSettings initial={{ escalation: { enabled: true, hours: 24 } }} />);
    const hours = screen.getByLabelText("After how many hours");
    await userEvent.clear(hours);
    await userEvent.type(hours, "6");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(api.put).toHaveBeenCalledWith(
      "/api/v1/settings/follow-ups",
      expect.objectContaining({ escalation: { enabled: true, hours: 6 }, digest: { enabled: true } }),
    );
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("turned off, the hours step back", async () => {
    render(<FollowUpSettings initial={{ escalation: { enabled: true, hours: 24 } }} />);
    await userEvent.click(screen.getByRole("switch", { name: "Tell managers about overdue follow-ups" }));
    expect(screen.getByLabelText("After how many hours")).toBeDisabled();
  });

  it("refuses hours outside 1 to a week before asking the server", async () => {
    render(<FollowUpSettings initial={{ escalation: { enabled: true, hours: 24 } }} />);
    const hours = screen.getByLabelText("After how many hours");
    await userEvent.clear(hours);
    await userEvent.type(hours, "200");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(api.put).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("between 1 and 168");
  });

  it("3B final review: the morning email can be switched off for everyone", async () => {
    vi.mocked(api.put).mockResolvedValue(ok(null));
    render(
      <FollowUpSettings initial={{ escalation: { enabled: true, hours: 24 }, digest: { enabled: true } }} />,
    );
    await userEvent.click(screen.getByRole("switch", { name: "Send the morning email" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(api.put).toHaveBeenCalledWith(
      "/api/v1/settings/follow-ups",
      expect.objectContaining({ escalation: { enabled: true, hours: 24 }, digest: { enabled: false } }),
    );
  });
});

describe("Settings → Follow-ups (3C Task 6)", () => {
  const full = {
    escalation: { enabled: true, hours: 24 },
    digest: { enabled: true },
    noTouch: { enabled: false, days: 7 },
    shiftToWorkingHours: true,
  };
  const hours = { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };
  it("leads gone quiet: off until switched on, then after how many days; saved with the rest", async () => {
    vi.mocked(api.put).mockResolvedValue(ok(null));
    render(<FollowUpSettings initial={full} workingHours={hours} />);
    const days = screen.getByLabelText("After how many days");
    expect(days).toBeDisabled();
    await userEvent.click(screen.getByRole("switch", { name: "Bring back leads that have gone quiet" }));
    await userEvent.clear(days);
    await userEvent.type(days, "10");
    await userEvent.click(
      screen.getByRole("switch", { name: "Keep LUME's follow-ups inside working hours" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(api.put).toHaveBeenCalledWith("/api/v1/settings/follow-ups", {
      escalation: { enabled: true, hours: 24 },
      digest: { enabled: true },
      noTouch: { enabled: true, days: 10 },
      shiftToWorkingHours: false,
    });
  });

  it("says the working hours in words, and where to change them; days outside 1–90 are refused", async () => {
    render(
      <FollowUpSettings initial={{ ...full, noTouch: { enabled: true, days: 7 } }} workingHours={hours} />,
    );
    expect(screen.getByText("Monday to Friday, 09:00–18:00")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Change them in Business" })).toHaveAttribute(
      "href",
      "/settings/business",
    );
    const days = screen.getByLabelText("After how many days");
    await userEvent.clear(days);
    await userEvent.type(days, "120");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("between 1 and 90");
    expect(api.put).not.toHaveBeenCalled();
  });
});

describe("My account → Notifications (3B Task 6)", () => {
  const prefs = {
    workingDays: [1, 2, 3, 4, 5],
    workStart: "09:00",
    workEnd: "18:00",
    digestTime: "08:00",
    sounds: { enabled: true, volume: 60 },
    alerts: { assigned: true, dueFollowUps: true, emailDigest: true },
  };
  it("each switch saves at once, and the digest time with it", async () => {
    vi.mocked(api.patch).mockResolvedValue(ok(null));
    render(<MyAlerts initial={prefs} />);
    await userEvent.click(screen.getByRole("switch", { name: "Follow-ups due" }));
    expect(api.patch).toHaveBeenCalledWith("/api/v1/me", {
      preferences: { alerts: { dueFollowUps: false } },
    });
    const time = screen.getByLabelText("Send it at");
    await userEvent.clear(time);
    await userEvent.type(time, "07:30");
    await userEvent.tab();
    expect(api.patch).toHaveBeenLastCalledWith("/api/v1/me", { preferences: { digestTime: "07:30" } });
  });

  it("with the digest off, its time steps back", async () => {
    vi.mocked(api.patch).mockResolvedValue(ok(null));
    render(<MyAlerts initial={prefs} />);
    await userEvent.click(screen.getByRole("switch", { name: "Morning email" }));
    expect(screen.getByLabelText("Send it at")).toBeDisabled();
  });

  it("3B final review: changing the time back to what it was is saved too", async () => {
    vi.mocked(api.patch).mockResolvedValue(ok(null));
    render(<MyAlerts initial={prefs} />);
    const time = screen.getByLabelText("Send it at");
    await userEvent.clear(time);
    await userEvent.type(time, "09:00");
    await userEvent.tab();
    await userEvent.clear(time);
    await userEvent.type(time, "08:00");
    await userEvent.tab();
    expect(api.patch).toHaveBeenLastCalledWith("/api/v1/me", { preferences: { digestTime: "08:00" } });
  });
});
