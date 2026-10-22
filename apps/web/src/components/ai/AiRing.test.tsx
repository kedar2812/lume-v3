import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiClient } from "@/lib/ai/client";
import type { AiStatus } from "@/lib/ai/types";
import { AiRing } from "./AiRing";

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
  paused: null,
  spend: null,
  pace: { daysLeft: 5 },
  topUp: null,
  ...o,
});
const ring = () => screen.getByRole("button", { name: /^LUME AI/ });
/** The ring's tone lives on its face (the trigger is the shared Popover's button). */
const tone = () => ring().querySelector("[data-tone]")?.getAttribute("data-tone") ?? null;

beforeEach(() => vi.clearAllMocks());

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
    await screen.findByRole("button", { name: "LUME AI: this month's allowance is used up" });
    expect(tone()).toBe("amber");
    await userEvent.click(ring());
    const panel = screen.getByRole("dialog", { name: "LUME AI this month" });
    expect(panel).toHaveTextContent("LUME AI has reached this month's allowance.");
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
