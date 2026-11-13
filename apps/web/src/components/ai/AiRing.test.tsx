import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiClient } from "@/lib/ai/client";
import type { AiStatus } from "@/lib/ai/types";
import { AiRing } from "./AiRing";
import { BIGGER_PLAN_NOTE } from "./AiRingPanel";

vi.mock("@/lib/ai/client", () => ({ aiClient: { status: vi.fn(), askTopUp: vi.fn() } }));
vi.mock("@/components/ZoneProvider", () => ({ useZone: () => "Asia/Kolkata" }));
const stream = vi.hoisted(() => ({ on: null as null | (() => void) }));
vi.mock("@/lib/notifications/stream", () => ({ useStream: (on: () => void) => (stream.on = on) }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

const status = (o: Partial<AiStatus> = {}): AiStatus => ({
  on: true,
  hour: { used: 4, limit: 100, resetsAt: "2026-10-21T11:00:00.000Z" },
  week: { used: 0, limit: null, resetsAt: "2026-10-25T18:30:00.000Z" },
  month: { used: 1920, limit: 3000, resetsAt: "2026-10-31T18:30:00.000Z" },
  // A licence server from before AI leads (plan4): the month's reads are the allowance.
  leads: { used: 0, limit: null, resetsAt: "2026-10-31T18:30:00.000Z" },
  countsLeads: false,
  paused: null,
  spend: null,
  pace: { daysLeft: 5 },
  topUp: null,
  ...o,
});
const ring = () => screen.getByRole("button", { name: /^LUME AI/ });
/** The ring's tone lives on its face (the trigger is the shared Popover's button). */
const tone = () => ring().querySelector("[data-tone]")?.getAttribute("data-tone") ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  // The panel weighs the pace against the days to the month's reset on the real clock: each test sets its own day,
  // 21 October, so the month resets in 10 days (a fixed reset date read against today broke on 27 October).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-21T10:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("LUME AI's ring (Autopilot spec 2026-10-19 §4)", () => {
  it("hidden while LUME AI is off for this person", async () => {
    vi.mocked(aiClient.status).mockResolvedValue(ok(status({ on: false })));
    const { container } = render(<AiRing />);
    await waitFor(() => expect(aiClient.status).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("its name says the month's share; amber past 80%", async () => {
    vi.mocked(aiClient.status).mockResolvedValue(ok(status()));
    render(<AiRing />);
    await screen.findByRole("button", { name: "LUME AI: 64% of this month used" });
    expect(tone()).toBeNull();
    vi.mocked(aiClient.status).mockResolvedValue(
      ok(status({ month: { used: 2550, limit: 3000, resetsAt: "2026-10-31T18:30:00.000Z" } })),
    );
    // Opening the panel looks again.
    await userEvent.click(ring());
    await waitFor(() => expect(tone()).toBe("amber"));
    expect(ring()).toHaveAccessibleName("LUME AI: 85% of this month used");
  });

  it("the panel says days left, this month and this hour, and when it resets", async () => {
    vi.mocked(aiClient.status).mockResolvedValue(ok(status()));
    render(<AiRing />);
    await userEvent.click(await screen.findByRole("button", { name: /^LUME AI/ }));
    const panel = screen.getByRole("dialog", { name: "LUME AI this month" });
    expect(panel).toHaveTextContent("64%");
    expect(panel).toHaveTextContent("About 5 days left at this pace");
    expect(panel).toHaveTextContent("1,920 of 3,000 this month");
    expect(panel).toHaveTextContent("4 of 100 this hour");
    expect(panel).toHaveTextContent("Resets on November 1");
    expect(panel).not.toHaveTextContent("$");
  });

  it("enough for the month when the pace lasts past the reset", async () => {
    vi.setSystemTime(new Date("2026-10-28T10:00:00Z")); // 3.4 days to the reset, 5 days of pace left
    vi.mocked(aiClient.status).mockResolvedValue(ok(status()));
    render(<AiRing />);
    await userEvent.click(await screen.findByRole("button", { name: /^LUME AI/ }));
    const panel = screen.getByRole("dialog", { name: "LUME AI this month" });
    expect(panel).toHaveTextContent("Enough for the month at this pace");
    expect(panel).not.toHaveTextContent("days left");
  });

  it("spend shows only when the server knows the prices", async () => {
    vi.mocked(aiClient.status).mockResolvedValue(
      ok(status({ spend: { used: 6, cap: 50, currency: "USD" } })),
    );
    render(<AiRing />);
    await userEvent.click(await screen.findByRole("button", { name: /^LUME AI/ }));
    expect(screen.getByRole("dialog", { name: "LUME AI this month" })).toHaveTextContent(
      "$6.00 of $50 this month",
    );
  });

  it("an admin at 85% may ask for a top-up, once; a rep never sees the button", async () => {
    const high = { month: { used: 2550, limit: 3000, resetsAt: "2026-10-31T18:30:00.000Z" } };
    vi.mocked(aiClient.status).mockResolvedValue(ok(status({ ...high, topUp: { asked: false } })));
    vi.mocked(aiClient.askTopUp).mockResolvedValue(ok({ asked: true as const }));
    const { unmount } = render(<AiRing />);
    await userEvent.click(await screen.findByRole("button", { name: /^LUME AI/ }));
    const panel = screen.getByRole("dialog", { name: "LUME AI this month" });
    await userEvent.click(within(panel).getByRole("button", { name: "Ask for a top-up" }));
    expect(aiClient.askTopUp).toHaveBeenCalledOnce();
    expect(panel).toHaveTextContent("Asked. LUME will let you know when it's added.");
    expect(within(panel).queryByRole("button", { name: "Ask for a top-up" })).toBeNull();
    expect(within(panel).getByRole("link", { name: "LUME AI settings" })).toHaveAttribute(
      "href",
      "/settings/ai",
    );
    unmount();

    vi.mocked(aiClient.status).mockResolvedValue(ok(status({ ...high, topUp: null })));
    render(<AiRing />);
    await userEvent.click(await screen.findByRole("button", { name: /^LUME AI/ }));
    expect(screen.queryByRole("button", { name: "Ask for a top-up" })).toBeNull();
    expect(screen.queryByRole("link", { name: "LUME AI settings" })).toBeNull();
  });

  it("paused by the month: says so, and offers the top-up to an admin", async () => {
    vi.mocked(aiClient.status).mockResolvedValue(
      ok(
        status({
          month: { used: 3000, limit: 3000, resetsAt: "2026-10-31T18:30:00.000Z" },
          paused: { by: "month", until: "2026-10-31T18:30:00.000Z" },
          topUp: { asked: false },
        }),
      ),
    );
    render(<AiRing />);
    await screen.findByRole("button", { name: "LUME AI: paused for the rest of the month" });
    expect(tone()).toBe("amber");
    await userEvent.click(ring());
    const panel = screen.getByRole("dialog", { name: "LUME AI this month" });
    expect(panel).toHaveTextContent("LUME AI is paused for the rest of the month. It's back on November 1.");
    expect(within(panel).getByRole("button", { name: "Ask for a top-up" })).toBeInTheDocument();
  });

  it("paused by the hour: says when it carries on", async () => {
    vi.mocked(aiClient.status).mockResolvedValue(
      ok(status({ paused: { by: "hour", until: "2026-10-21T10:10:00.000Z" } })),
    );
    render(<AiRing />);
    await userEvent.click(await screen.findByRole("button", { name: /^LUME AI/ }));
    expect(screen.getByRole("dialog", { name: "LUME AI this month" })).toHaveTextContent(
      "LUME AI has reached this hour's limit. It's back at 3:40 pm.",
    );
  });

  it("a licence without a monthly allowance: the week's share, and no top-up to ask for", async () => {
    vi.mocked(aiClient.status).mockResolvedValue(
      ok(
        status({
          week: { used: 450, limit: 500, resetsAt: "2026-10-25T18:30:00.000Z" },
          month: { used: 1200, limit: null, resetsAt: "2026-10-31T18:30:00.000Z" },
          pace: { daysLeft: null },
          topUp: { asked: false },
        }),
      ),
    );
    render(<AiRing />);
    await userEvent.click(await screen.findByRole("button", { name: "LUME AI: 90% of this week used" }));
    const panel = screen.getByRole("dialog", { name: "LUME AI this month" });
    expect(panel).toHaveTextContent("450 of 500 this week");
    expect(panel).toHaveTextContent("1,200 this month");
    expect(within(panel).queryByRole("button", { name: "Ask for a top-up" })).toBeNull();
  });

  it("looks again when a notification arrives", async () => {
    vi.mocked(aiClient.status).mockResolvedValue(ok(status()));
    render(<AiRing />);
    await screen.findByRole("button", { name: "LUME AI: 64% of this month used" });
    vi.mocked(aiClient.status).mockResolvedValue(
      ok(status({ month: { used: 2700, limit: 3000, resetsAt: "2026-10-31T18:30:00.000Z" } })),
    );
    act(() => stream.on?.());
    expect(
      await screen.findByRole("button", { name: "LUME AI: 90% of this month used" }),
    ).toBeInTheDocument();
  });
});

describe("LUME AI's mark in the ring (seen broken in the e2e screenshots: an <img> of a file the app doesn't serve)", () => {
  const LOOP = 'path[d^="M16 84"]';
  it("the ring and its panel draw The Loop, and load no image", async () => {
    vi.mocked(aiClient.status).mockResolvedValue(ok(status()));
    render(<AiRing />);
    const button = await screen.findByRole("button", { name: /^LUME AI/ });
    expect(button.querySelector("img")).toBeNull();
    expect(button.querySelector(LOOP)).not.toBeNull();
    await userEvent.click(button);
    const panel = screen.getByRole("dialog", { name: "LUME AI this month" });
    expect(panel.querySelector("img")).toBeNull();
    expect(panel.querySelector(LOOP)).not.toBeNull();
  });
});

/** AI leads (owner's spec 2026-11-12): "X of Y AI leads used this month", 80% and 100%. */
describe("the ring counts AI leads", () => {
  const leads = (used: number, limit: number | null, o: Partial<AiStatus> = {}) =>
    status({
      countsLeads: true,
      leads: { used, limit, resetsAt: "2026-10-31T18:30:00.000Z" },
      // The safety net: never shown as numbers.
      hour: { used: 4, limit: 100, resetsAt: "2026-10-21T11:00:00.000Z" },
      month: { used: 5000, limit: 30_000, resetsAt: "2026-10-31T18:30:00.000Z" },
      ...o,
    });
  const open = async () => {
    await userEvent.click(await screen.findByRole("button", { name: /^LUME AI/ }));
    return screen.getByRole("dialog", { name: "LUME AI this month" });
  };

  it("says X of Y AI leads used this month, and never the hour or the month's reads", async () => {
    vi.mocked(aiClient.status).mockResolvedValue(ok(leads(612, 1000)));
    render(<AiRing />);
    await screen.findByRole("button", { name: "LUME AI: 612 of 1,000 AI leads used this month" });
    expect(tone()).toBeNull();
    const panel = await open();
    expect(panel).toHaveTextContent("612 of 1,000 AI leads used this month");
    expect(panel).toHaveTextContent("61%");
    expect(panel).not.toHaveTextContent("this hour");
    expect(panel).not.toHaveTextContent("30,000");
    expect(panel).not.toHaveTextContent(/reads|actions/);
  });

  it("79%: no amber, no top-up; 80%: amber, and an admin may ask", async () => {
    vi.mocked(aiClient.status).mockResolvedValue(ok(leads(790, 1000, { topUp: { asked: false } })));
    const { unmount } = render(<AiRing />);
    let panel = await open();
    expect(tone()).toBeNull();
    expect(within(panel).queryByRole("button", { name: /Ask/ })).toBeNull();
    unmount();
    vi.mocked(aiClient.status).mockResolvedValue(ok(leads(800, 1000, { topUp: { asked: false } })));
    render(<AiRing />);
    panel = await open();
    expect(tone()).toBe("amber");
    expect(
      within(panel).getByRole("button", { name: "Ask for a top-up of 100 AI leads" }),
    ).toBeInTheDocument();
  });

  it("100%: says new leads wait and counted ones carry on; top-up and bigger plan for an admin", async () => {
    vi.mocked(aiClient.status).mockResolvedValue(ok(leads(1000, 1000, { topUp: { asked: false } })));
    vi.mocked(aiClient.askTopUp).mockResolvedValue(ok({ asked: true as const }));
    render(<AiRing />);
    await screen.findByRole("button", { name: "LUME AI: this month's AI leads are used up" });
    expect(tone()).toBe("amber");
    const panel = await open();
    expect(panel).toHaveTextContent(
      "This month's AI leads are used up. Leads LUME AI is already working on carry on; new leads start on November 1, or sooner with a top-up.",
    );
    expect(panel).not.toHaveTextContent("days left");
    await userEvent.click(within(panel).getByRole("button", { name: "Ask about a bigger plan" }));
    expect(aiClient.askTopUp).toHaveBeenCalledWith(BIGGER_PLAN_NOTE);
    expect(panel).toHaveTextContent("Asked. LUME will let you know when it's added.");
    expect(within(panel).queryByRole("button", { name: /Ask/ })).toBeNull();
  });

  it("a top-up asked from the first button goes without a note", async () => {
    vi.mocked(aiClient.status).mockResolvedValue(ok(leads(1000, 1000, { topUp: { asked: false } })));
    vi.mocked(aiClient.askTopUp).mockResolvedValue(ok({ asked: true as const }));
    render(<AiRing />);
    const panel = await open();
    await userEvent.click(within(panel).getByRole("button", { name: "Ask for a top-up of 100 AI leads" }));
    expect(aiClient.askTopUp).toHaveBeenCalledWith(undefined);
  });

  it("100% for a rep: no buttons, and who can ask", async () => {
    vi.mocked(aiClient.status).mockResolvedValue(ok(leads(1000, 1000, { topUp: null })));
    render(<AiRing />);
    const panel = await open();
    expect(within(panel).queryByRole("button", { name: /Ask/ })).toBeNull();
    expect(panel).toHaveTextContent("An admin can ask for a top-up from here.");
  });

  it("Base (0 AI leads): says the plan has none", async () => {
    vi.mocked(aiClient.status).mockResolvedValue(ok(leads(0, 0, { topUp: null })));
    render(<AiRing />);
    await screen.findByRole("button", { name: "LUME AI: this month's AI leads are used up" });
    const panel = await open();
    expect(panel).toHaveTextContent("Your plan has no AI leads, so LUME AI can't start on a lead.");
    expect(panel).not.toHaveTextContent("An admin can ask");
  });

  it("no limit: the count alone", async () => {
    vi.mocked(aiClient.status).mockResolvedValue(ok(leads(3, null, { pace: { daysLeft: null } })));
    render(<AiRing />);
    await screen.findByRole("button", { name: "LUME AI: 3 AI leads this month" });
    const panel = await open();
    expect(panel).toHaveTextContent("3 AI leads this month");
    expect(panel).not.toHaveTextContent("%");
  });

  it("the safety net reached: paused for the month, with no number", async () => {
    vi.mocked(aiClient.status).mockResolvedValue(
      ok(
        leads(300, 1000, {
          paused: { by: "month", until: "2026-10-31T18:30:00.000Z" },
          topUp: { asked: false },
        }),
      ),
    );
    render(<AiRing />);
    await screen.findByRole("button", { name: "LUME AI: paused for the rest of the month" });
    const panel = await open();
    expect(panel).toHaveTextContent("LUME AI is paused for the rest of the month. It's back on November 1.");
    expect(panel).not.toHaveTextContent("30,000");
  });
});
