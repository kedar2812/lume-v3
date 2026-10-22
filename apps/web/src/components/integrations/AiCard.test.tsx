import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiClient } from "@/lib/ai/client";
import type { AiStatus } from "@/lib/ai/types";
import { LicenceProvider } from "@/components/licence/LicenceProvider";
import { fakeSession } from "@/server/session";
import { AiCard } from "./AiCard";

vi.mock("@/lib/ai/client", () => ({ aiClient: { setEnabled: vi.fn(), status: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const TZ = "Asia/Kolkata";
const status = (over: Partial<AiStatus> = {}): AiStatus => ({
  on: true,
  hour: { used: 12, limit: 100, resetsAt: "2026-10-21T10:10:00.000Z" }, // 3:40 pm in Kolkata
  week: { used: 640, limit: 750, resetsAt: "2026-10-25T18:30:00.000Z" }, // Monday 12 am in Kolkata
  month: { used: 640, limit: null, resetsAt: "2026-10-31T18:30:00.000Z" },
  paused: null,
  spend: null,
  pace: { daysLeft: null },
  topUp: null,
  ...over,
});
const view = (ai: { enabled: boolean; available: boolean; inPlan: boolean }) => ({
  googleSheets: { enabled: false, available: false, email: null, connectWithGoogle: false },
  webhooks: { enabled: false, manychat: false },
  googleCalendar: { enabled: false, available: false },
  calendly: { connected: false },
  ai,
});

beforeEach(() => {
  vi.clearAllMocks();
  // Wednesday 21 October, 3:30 pm in Kolkata: the reset times below are this day's and next Monday's.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-21T10:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("the LUME AI card (spec 2026-10-18 §2.2)", () => {
  it("is off by default: one switch, what it does, and what's sent where", async () => {
    const onView = vi.fn();
    vi.mocked(aiClient.setEnabled).mockResolvedValue(
      ok(view({ enabled: true, available: true, inPlan: true })),
    );
    render(<AiCard ai={{ enabled: false, available: true, inPlan: true }} tz={TZ} onView={onView} />);
    expect(
      screen.getByText("Reads a note after a call and suggests the next step. A person always decides."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The words of a note are sent to the AI provider to be read. They aren't used to train it, and nothing is ever sent to a lead.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("This hour")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: "LUME AI" }));
    expect(aiClient.setEnabled).toHaveBeenCalledWith(true);
    expect(onView).toHaveBeenCalled();
  });

  it("on: this hour's and this week's use, with when each resets, in words and not colour alone", async () => {
    vi.mocked(aiClient.status).mockResolvedValue(ok(status()));
    render(<AiCard ai={{ enabled: true, available: true, inPlan: true }} tz={TZ} onView={vi.fn()} />);
    expect(await screen.findByText("12 of 100 · resets 3:40 pm")).toBeInTheDocument();
    expect(screen.getByText("640 of 750 · resets Monday 12 am")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "12 of 100 reads this hour" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "640 of 750 reads this week" })).toBeInTheDocument();
  });

  it("a monthly allowance (Autopilot A1): this hour's and this month's use; a week with no limit of its own isn't shown", async () => {
    vi.mocked(aiClient.status).mockResolvedValue(
      ok(
        status({
          week: { used: 640, limit: null, resetsAt: "2026-10-25T18:30:00.000Z" },
          month: { used: 1920, limit: 3000, resetsAt: "2026-10-31T18:30:00.000Z" },
        }),
      ),
    );
    render(<AiCard ai={{ enabled: true, available: true, inPlan: true }} tz={TZ} onView={vi.fn()} />);
    expect(await screen.findByText("1,920 of 3,000 · resets November 1")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "1,920 of 3,000 reads this month" })).toBeInTheDocument();
    expect(screen.getByText("12 of 100 · resets 3:40 pm")).toBeInTheDocument();
    expect(screen.queryByText("This week")).not.toBeInTheDocument();
  });

  it("no limit: the count alone, no bar", async () => {
    vi.mocked(aiClient.status).mockResolvedValue(
      ok(status({ hour: { used: 3, limit: null, resetsAt: "2026-10-21T10:10:00.000Z" } })),
    );
    render(<AiCard ai={{ enabled: true, available: true, inPlan: true }} tz={TZ} onView={vi.fn()} />);
    expect(await screen.findByText("3 · no limit")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /reads this hour/ })).not.toBeInTheDocument();
  });

  it("at a limit: says which, when it's back, and that notes still save", async () => {
    vi.mocked(aiClient.status).mockResolvedValue(
      ok(
        status({
          week: { used: 750, limit: 750, resetsAt: "2026-10-25T18:30:00.000Z" },
          paused: { by: "week", until: "2026-10-25T18:30:00.000Z" },
        }),
      ),
    );
    render(<AiCard ai={{ enabled: true, available: true, inPlan: true }} tz={TZ} onView={vi.fn()} />);
    expect(
      await screen.findByText(
        "LUME AI has reached this week's limit. It's back Monday. Notes and calls still save as usual.",
      ),
    ).toBeInTheDocument();
  });

  it("not set up on this server: says so, and the switch stays off", () => {
    render(<AiCard ai={{ enabled: false, available: false, inPlan: true }} tz={TZ} onView={vi.fn()} />);
    expect(screen.getByText("LUME AI isn't set up on this server yet.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "LUME AI, not set up here" })).toBeDisabled();
  });

  it("not in this LUME's plan: says so, and the switch stays off and still", () => {
    const session = fakeSession();
    const modules = {
      googleSheets: true,
      webhooks: true,
      googleCalendar: true,
      calendly: true,
      ai: false,
      whatsapp: true,
    };
    render(
      <LicenceProvider
        session={{ ...session, licence: { ...session.licence, plan: { places: null, taken: 1, modules } } }}
      >
        <AiCard ai={{ enabled: true, available: true, inPlan: false }} tz={TZ} onView={vi.fn()} />
      </LicenceProvider>,
    );
    const sw = screen.getByRole("switch", { name: "LUME AI, not in this LUME’s plan" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw).toBeDisabled();
    expect(aiClient.status).not.toHaveBeenCalled();
  });

  it("a refusal from the server is said in its own words", async () => {
    vi.mocked(aiClient.setEnabled).mockResolvedValue({
      ok: false,
      status: 409,
      code: "AI_NOT_CONFIGURED",
      message: "LUME AI isn't set up on this server yet.",
    } as never);
    render(<AiCard ai={{ enabled: false, available: true, inPlan: true }} tz={TZ} onView={vi.fn()} />);
    await userEvent.click(screen.getByRole("switch", { name: "LUME AI" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("LUME AI isn't set up on this server yet.");
  });
});
