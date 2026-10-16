// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/client";
import { PlanLimits } from "./PlanLimits";

vi.mock("@/lib/client", () => ({
  CHANGED: "lume-licence:changed",
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

const all = { googleSheets: true, webhooks: true, googleCalendar: true, calendly: true };
const card = (o: Partial<Parameters<typeof PlanLimits>[0]> = {}) =>
  render(
    <PlanLimits
      clientId="c1"
      clientName="Kestrel Logistics"
      version="1.5.0"
      plan={{ places: null, modules: all }}
      usage={{ people: 4, modulesOn: ["webhooks", "calendly"], knows: true }}
      onSaved={vi.fn()}
      {...o}
    />,
  );
beforeEach(() => vi.mocked(api.patch).mockReset());

describe("Plan limits (spec 2026-10-17 control §3.3)", () => {
  it("starts as it is: no limit, every module in; Save waits for a change", () => {
    card();
    expect(screen.getByRole("radio", { name: "No limit" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("4 people use it now.")).toBeInTheDocument();
    for (const m of ["Google Sheets", "Webhooks", "Google Calendar", "Calendly"])
      expect(screen.getByRole("switch", { name: `${m} in their plan` })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("a number of places, kept between 1 and 10,000, and how many are free", async () => {
    const user = userEvent.setup();
    card();
    await user.click(screen.getByRole("radio", { name: "A number" }));
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("4 people use it now: 1 place free.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "One fewer" }));
    await user.click(screen.getByRole("button", { name: "One fewer" }));
    expect(
      screen.getByText(
        "4 people use it now: nobody loses access, but no one new can be added until there’s room.",
      ),
    ).toBeInTheDocument();
    for (let i = 0; i < 5; i++) await user.click(screen.getByRole("button", { name: "One fewer" }));
    expect(screen.getByRole("button", { name: "One fewer" })).toBeDisabled();
  });

  it("warns before taking away a module that's on at the client now, and saves exactly what's set", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    vi.mocked(api.patch).mockResolvedValue({ ok: true, data: { plan: {}, usage: {} } } as never);
    card({ onSaved });
    await user.click(screen.getByRole("switch", { name: "Calendly in their plan" }));
    expect(
      screen.getByText("On at Kestrel Logistics now — switching it off stops it at their next check-in."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "A number" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.patch).toHaveBeenCalledWith("/api/clients/c1/plan", {
      places: 5,
      modules: { googleSheets: true, webhooks: true, googleCalendar: true, calendly: false },
    });
    expect(
      screen.getByText("Saved. Their LUME keeps it from its next check-in, within 6 hours."),
    ).toBeInTheDocument();
  });

  it("on an older LUME says it can't keep one yet, and still saves", () => {
    card({ usage: { people: 3, modulesOn: [], knows: false }, version: "1.4.2" });
    expect(
      screen.getByText(
        "Their LUME (1.4.2) can’t keep a plan yet; it will once it’s updated. What you set here waits for it.",
      ),
    ).toBeInTheDocument();
  });
});
