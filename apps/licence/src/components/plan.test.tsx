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
        aiLeadsMonthly: null,
      }}
      usage={{
        people: 4,
        modulesOn: ["webhooks", "calendly"],
        knows: true,
        knowsAi: true,
        knowsPaid: true,
        knowsMonthly: true,
        knowsLeads: true,
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
    expect(screen.getByRole("spinbutton", { name: "Most an hour" })).toHaveValue(null);
    expect(screen.getByRole("spinbutton", { name: "Most a week (LUME before monthly limits)" })).toHaveValue(
      null,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("AI limits: empty is no limit, a whole number from 1 is saved, anything else is said and not saved", async () => {
    const user = userEvent.setup();
    vi.mocked(api.patch).mockResolvedValue({ ok: true, data: { plan: {}, usage: {} } } as never);
    card();
    const hour = screen.getByRole("spinbutton", { name: "Most an hour" });
    await user.type(hour, "0");
    expect(screen.getByText("A whole number from 1, or empty for no limit.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.clear(hour);
    await user.type(hour, "100");
    await user.type(
      screen.getByRole("spinbutton", { name: "Most a week (LUME before monthly limits)" }),
      "750",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/clients/c1/plan", {
        places: null,
        modules: all,
        aiReadsHourly: 100,
        aiReadsWeekly: 750,
        paidSendsMonthly: null,
        aiCallsMonthly: null,
        aiLeadsMonthly: null,
        tier: null,
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
        aiLeadsMonthly: null,
        tier: null,
      }),
    );
  });

  it("W3b-2: on a LUME that can't keep the WhatsApp limit yet, says so", () => {
    card({
      usage: { people: 3, modulesOn: [], knows: true, knowsAi: true, knowsPaid: false, knowsMonthly: true },
    });
    expect(
      screen.getByText("Their LUME (1.5.0) can’t keep this limit yet; it will once it’s updated."),
    ).toBeInTheDocument();
  });

  it("on a LUME that can keep a plan but not LUME AI's limits yet, says so", () => {
    card({
      usage: { people: 3, modulesOn: [], knows: true, knowsAi: false, knowsPaid: false, knowsMonthly: true },
    });
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
      aiLeadsMonthly: null,
      tier: null,
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
    await user.type(screen.getByRole("spinbutton", { name: "Most a month" }), "5000");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(api.patch).toHaveBeenCalledWith(
      "/api/clients/c1/plan",
      expect.objectContaining({ aiCallsMonthly: 5000 }),
    );
  });

  it("an older LUME counts LUME AI by its actions until it's updated, and says so", () => {
    card({
      usage: { people: 3, modulesOn: [], knows: true, knowsAi: true, knowsPaid: true, knowsMonthly: false },
    });
    expect(
      screen.getByText(
        "Their LUME (1.5.0) counts LUME AI by its actions until it’s updated: 7 for each AI lead, unless you set the month below.",
      ),
    ).toBeInTheDocument();
  });

  it("the history says a top-up asked for and one added", () => {
    const line = (kind: string, detail: Record<string, unknown>) =>
      said({ kind, detail } as unknown as Parameters<typeof said>[0]).text;
    expect(line("topup_requested", { month: "2026-10", by: "Priya Shah" })).toBe(
      "Priya Shah asked for a LUME AI top-up for October 2026",
    );
    expect(line("ai_topup", { month: "2026-10", calls: 1500 })).toBe(
      "LUME AI top-up: 1,500 calls for October 2026",
    );
    // AI leads (2026-11-12): packs of 100 AI leads.
    expect(line("ai_topup", { month: "2026-11", leads: 300 })).toBe(
      "LUME AI top-up: 300 AI leads for November 2026",
    );
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
      "Plan: no limit on places; every module included; LUME AI at most 100 an hour, 750 a week",
    );
    expect(plan({ places: null, left: [], aiReadsHourly: null, aiReadsWeekly: 250 })).toBe(
      "Plan: no limit on places; every module included; LUME AI at most 250 a week",
    );
    expect(plan({ places: null, left: [], paidSendsMonthly: 1000 })).toBe(
      "Plan: no limit on places; every module included; 1,000 paid WhatsApp messages a month",
    );
    expect(plan({ places: null, left: [], aiLeadsMonthly: 1000, aiCallsMonthly: 5000 })).toBe(
      "Plan: no limit on places; every module included; 1,000 AI leads a month; LUME AI at most 5,000 a month",
    );
    expect(plan({ places: null, left: [], aiLeadsMonthly: 0 })).toBe(
      "Plan: no limit on places; every module included; 0 AI leads a month",
    );
    expect(plan({ places: null, left: [], aiCallsMonthly: 5000 })).toBe(
      "Plan: no limit on places; every module included; LUME AI at most 5,000 a month",
    );
  });
});

/** AI leads (owner's spec 2026-11-12 §2): a tier, or a number of the owner's; the safety net under it. */
describe("AI leads a month", () => {
  const ok = { ok: true, data: { plan: {}, usage: {} } } as never;
  it("a tier sets its number: Base 0, Pro 1,000, Max 3,000, Enterprise 10,000; No limit is empty", async () => {
    const user = userEvent.setup();
    vi.mocked(api.patch).mockResolvedValue(ok);
    card();
    expect(screen.getByRole("radio", { name: "No AI leads limit" })).toHaveAttribute("aria-checked", "true");
    const group = screen.getByRole("radiogroup", { name: "AI leads a month" });
    expect(group).toHaveTextContent("Base · 0Pro · 1,000Max · 3,000Enterprise · 10,000No limitCustom");
    await user.click(screen.getByRole("radio", { name: "Pro: 1,000 AI leads" }));
    expect(screen.getByRole("radio", { name: "Pro: 1,000 AI leads" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(api.patch).toHaveBeenCalledWith(
      "/api/clients/c1/plan",
      expect.objectContaining({ aiLeadsMonthly: 1000 }),
    );
  });

  it("Custom: any number from 0, said when it isn't one", async () => {
    const user = userEvent.setup();
    vi.mocked(api.patch).mockResolvedValue(ok);
    card();
    await user.click(screen.getByRole("radio", { name: "Custom" }));
    const box = screen.getByRole("spinbutton", { name: "AI leads a month" });
    await user.type(box, "-5");
    expect(screen.getByText("A whole number from 0, or empty for no limit.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.clear(box);
    await user.type(box, "2500");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(api.patch).toHaveBeenCalledWith(
      "/api/clients/c1/plan",
      expect.objectContaining({ aiLeadsMonthly: 2500 }),
    );
  });

  it("a saved number no tier has opens on Custom; a tier's own number on its tier", () => {
    const base = {
      places: null,
      modules: all,
      aiReadsHourly: null,
      aiReadsWeekly: null,
      paidSendsMonthly: null,
      aiCallsMonthly: null,
      aiTopUps: [],
    };
    const { unmount } = card({ plan: { ...base, aiLeadsMonthly: 2500 } });
    expect(screen.getByRole("radio", { name: "Custom" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("spinbutton", { name: "AI leads a month" })).toHaveValue(2500);
    unmount();
    card({ plan: { ...base, aiLeadsMonthly: 3000 } });
    expect(screen.getByRole("radio", { name: "Max: 3,000 AI leads" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.queryByRole("spinbutton", { name: "AI leads a month" })).toBeNull();
  });

  it("Base says what still runs, and how to stop LUME AI altogether", async () => {
    const user = userEvent.setup();
    card();
    await user.click(screen.getByRole("radio", { name: "Base: 0 AI leads" }));
    expect(
      screen.getByText(
        "Base: LUME AI starts on no lead. Choosing a template and reading replies still work while LUME AI is on; switch LUME AI off above to stop it all.",
      ),
    ).toBeInTheDocument();
  });

  it("a tier (Plans and pricing): picks its AI leads, says what it locks, and is saved with the plan", async () => {
    const user = userEvent.setup();
    vi.mocked(api.patch).mockResolvedValue(ok);
    card({
      usage: {
        people: 4,
        modulesOn: [],
        knows: true,
        knowsAi: true,
        knowsPaid: true,
        knowsMonthly: true,
        knowsLeads: true,
        knowsTiers: true,
      },
    });
    expect(screen.getByRole("radio", { name: "No tier" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/No tier: nothing is locked/)).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Pro" }));
    expect(screen.getByRole("radio", { name: "Pro: 1,000 AI leads" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByText(/When a lead writes back, it’s their team’s to answer/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(api.patch).toHaveBeenCalledWith(
      "/api/clients/c1/plan",
      expect.objectContaining({ tier: "pro", aiLeadsMonthly: 1000 }),
    );
  });

  it("a tier keeps a Custom number; Base says LUME AI goes off", async () => {
    const user = userEvent.setup();
    card({
      usage: {
        people: 4,
        modulesOn: [],
        knows: true,
        knowsAi: true,
        knowsPaid: true,
        knowsMonthly: true,
        knowsLeads: true,
        knowsTiers: true,
      },
    });
    await user.click(screen.getByRole("radio", { name: "Custom" }));
    const box = screen.getByRole("spinbutton", { name: "AI leads a month" });
    await user.type(box, "12000");
    await user.click(screen.getByRole("radio", { name: "Enterprise" }));
    expect(box).toHaveValue(12000);
    await user.click(screen.getByRole("radio", { name: "Base" }));
    expect(screen.getByText(/Base is LUME without AI/)).toBeInTheDocument();
  });

  it("on a LUME that can't keep a tier yet, says what Base still does there", async () => {
    const user = userEvent.setup();
    card();
    await user.click(screen.getByRole("radio", { name: "Max" }));
    expect(screen.getByText(/can’t keep a tier yet/)).toBeInTheDocument();
  });

  it("the safety net: hidden from them; an empty month is automatic", () => {
    card();
    expect(screen.getByText("Safety net (they never see it)")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Most a month" })).toHaveAttribute(
      "placeholder",
      "Automatic",
    );
    expect(
      screen.getByText(
        "How many times LUME AI may run, well above what they use. An empty month is automatic: 30 for each AI lead, at least 1,000.",
      ),
    ).toBeInTheDocument();
  });
});
