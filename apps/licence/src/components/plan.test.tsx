// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/client";
import { said } from "./ClientScreen";
import { PlanLimits } from "./PlanLimits";

vi.mock("@/lib/client", () => ({
  CHANGED: "lume-licence:changed",
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

const all = {
  googleSheets: true,
  webhooks: true,
  googleCalendar: true,
  calendly: true,
  ai: true,
  whatsapp: true,
};
const card = (o: Partial<Parameters<typeof PlanLimits>[0]> = {}) =>
  render(
    <PlanLimits
      clientId="c1"
      clientName="Kestrel Logistics"
      version="1.5.0"
      plan={{ places: null, modules: all, aiReadsHourly: null, aiReadsWeekly: null }}
      usage={{ people: 4, modulesOn: ["webhooks", "calendly"], knows: true, knowsAi: true }}
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
    for (const m of ["Google Sheets", "Webhooks", "Google Calendar", "Calendly", "LUME AI", "WhatsApp"])
      expect(screen.getByRole("switch", { name: `${m} in their plan` })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    expect(screen.getByRole("spinbutton", { name: "AI reads an hour" })).toHaveValue(null);
    expect(screen.getByRole("spinbutton", { name: "AI reads a week" })).toHaveValue(null);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("AI limits: empty is no limit, a whole number from 1 is saved, anything else is said and not saved", async () => {
    const user = userEvent.setup();
    vi.mocked(api.patch).mockResolvedValue({ ok: true, data: { plan: {}, usage: {} } } as never);
    card();
    const hour = screen.getByRole("spinbutton", { name: "AI reads an hour" });
    await user.type(hour, "0");
    expect(screen.getByText("A whole number from 1, or empty for no limit.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.clear(hour);
    await user.type(hour, "100");
    await user.type(screen.getByRole("spinbutton", { name: "AI reads a week" }), "750");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/clients/c1/plan", {
        places: null,
        modules: all,
        aiReadsHourly: 100,
        aiReadsWeekly: 750,
      }),
    );
  });

  it("on a LUME that can keep a plan but not LUME AI's limits yet, says so", () => {
    card({ usage: { people: 3, modulesOn: [], knows: true, knowsAi: false } });
    expect(
      screen.getByText(
        "Their LUME (1.5.0) can’t keep LUME AI and WhatsApp settings yet; it will once it’s updated.",
      ),
    ).toBeInTheDocument();
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
      modules: { ...all, calendly: false },
      aiReadsHourly: null,
      aiReadsWeekly: null,
    });
    expect(
      screen.getByText("Saved. Their LUME keeps it from its next check-in, within 6 hours."),
    ).toBeInTheDocument();
  });

  it("on an older LUME says it can't keep one yet, and still saves", () => {
    card({ usage: { people: 3, modulesOn: [], knows: false, knowsAi: false }, version: "1.4.2" });
    expect(
      screen.getByText(
        "Their LUME (1.4.2) can’t keep a plan yet; it will once it’s updated. What you set here waits for it.",
      ),
    ).toBeInTheDocument();
  });
});

describe("a plan change in the client's history", () => {
  const plan = (detail: Record<string, unknown>) =>
    said({ kind: "plan", detail } as unknown as Parameters<typeof said>[0]).text;
  it("names LUME AI and WhatsApp, and says the AI limits when they're set", () => {
    expect(plan({ places: 5, left: ["ai", "whatsapp"] })).toBe(
      "Plan: 5 places; LUME AI, WhatsApp not included",
    );
    expect(plan({ places: null, left: [], aiReadsHourly: 100, aiReadsWeekly: 750 })).toBe(
      "Plan: no limit on places; every module included; LUME AI 100 reads an hour, 750 a week",
    );
    expect(plan({ places: null, left: [], aiReadsHourly: null, aiReadsWeekly: 250 })).toBe(
      "Plan: no limit on places; every module included; LUME AI 250 reads a week",
    );
  });
});
