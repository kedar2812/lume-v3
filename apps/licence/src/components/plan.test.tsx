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
      plan={{
        places: null,
        modules: all,
        aiReadsHourly: null,
        aiReadsWeekly: null,
        paidSendsMonthly: null,
        aiCallsMonthly: null,
        aiTopUps: [],
      }}
      usage={{
        people: 4,
        modulesOn: ["webhooks", "calendly"],
        knows: true,
        knowsAi: true,
        knowsPaid: true,
        knowsMonthly: true,
      }}
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
        paidSendsMonthly: null,
        aiCallsMonthly: null,
      }),
    );
  });

  it("W3b-2: paid WhatsApp messages a month: empty is no limit, a whole number is saved", async () => {
    const user = userEvent.setup();
    vi.mocked(api.patch).mockResolvedValue({ ok: true, data: { plan: {}, usage: {} } } as never);
    card();
    const paid = screen.getByRole("spinbutton", { name: "Paid WhatsApp messages a month" });
    expect(paid).toHaveValue(null);
    await user.type(paid, "1000");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/clients/c1/plan", {
        places: null,
        modules: all,
        aiReadsHourly: null,
        aiReadsWeekly: null,
        paidSendsMonthly: 1000,
        aiCallsMonthly: null,
      }),
    );
  });

  it("W3b-2: on a LUME that can't keep the WhatsApp limit yet, says so", () => {
    card({ usage: { people: 3, modulesOn: [], knows: true, knowsAi: true, knowsPaid: false, knowsMonthly: true } });
    expect(
      screen.getByText("Their LUME (1.5.0) can’t keep this limit yet; it will once it’s updated."),
    ).toBeInTheDocument();
  });

  it("on a LUME that can keep a plan but not LUME AI's limits yet, says so", () => {
    card({ usage: { people: 3, modulesOn: [], knows: true, knowsAi: false, knowsPaid: false, knowsMonthly: true } });
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
      screen.getByText("On at Kestrel Logistics now. Switching it off stops it at their next check-in."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "A number" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.patch).toHaveBeenCalledWith("/api/clients/c1/plan", {
      places: 5,
      modules: { ...all, calendly: false },
      aiReadsHourly: null,
      aiReadsWeekly: null,
      paidSendsMonthly: null,
      aiCallsMonthly: null,
    });
    expect(
      screen.getByText("Saved. Their LUME keeps it from its next check-in, within 6 hours."),
    ).toBeInTheDocument();
  });

  it("on an older LUME says it can't keep one yet, and still saves", () => {
    card({
      usage: { people: 3, modulesOn: [], knows: false, knowsAi: false, knowsPaid: false, knowsMonthly: true },
      version: "1.4.2",
    });
    expect(
      screen.getByText(
        "Their LUME (1.4.2) can’t keep a plan yet; it will once it’s updated. What you set here waits for it.",
      ),
    ).toBeInTheDocument();
  });
});

describe("Autopilot A1: LUME AI a month, and top-ups", () => {
  it("LUME AI a month is saved like the other limits", async () => {
    const user = userEvent.setup();
    vi.mocked(api.patch).mockResolvedValue({ ok: true, data: { plan: {}, usage: {} } } as never);
    card();
    await user.type(screen.getByRole("spinbutton", { name: "LUME AI calls a month" }), "5000");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(api.patch).toHaveBeenCalledWith("/api/clients/c1/plan", expect.objectContaining({ aiCallsMonthly: 5000 }));
  });

  it("an older LUME keeps the weekly reads until it's updated, and says so", () => {
    card({
      usage: { people: 3, modulesOn: [], knows: true, knowsAi: true, knowsPaid: true, knowsMonthly: false },
    });
    expect(screen.getByText(/keeps the weekly reads until it.s updated/)).toBeInTheDocument();
  });

  it("the history says a top-up asked for and one added", () => {
    const line = (kind: string, detail: Record<string, unknown>) =>
      said({ kind, detail } as unknown as Parameters<typeof said>[0]).text;
    expect(line("topup_requested", { month: "2026-10", by: "Priya Shah" })).toBe(
      "Priya Shah asked for a LUME AI top-up for October 2026",
    );
    expect(line("ai_topup", { month: "2026-10", calls: 1500 })).toBe("LUME AI top-up: 1,500 calls for October 2026");
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
    expect(plan({ places: null, left: [], paidSendsMonthly: 1000 })).toBe(
      "Plan: no limit on places; every module included; 1,000 paid WhatsApp messages a month",
    );
    expect(plan({ places: null, left: [], aiCallsMonthly: 5000 })).toBe(
      "Plan: no limit on places; every module included; LUME AI 5,000 calls a month",
    );
  });
});
