import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiClient } from "@/lib/ai/client";
import { CatchUp } from "./CatchUp";

vi.mock("@/lib/ai/client", () => ({ aiClient: { catchUp: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const TZ = "Asia/Kolkata";
const LINES: [string, string, string] = [
  "Karthik wants full home interiors for a 3BHK and is comparing two studios.",
  "The design and quote went out on October 9; he said he'd discuss it at home.",
  "A call back was promised for this week.",
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-21T10:00:00Z")); // Wednesday 3:30 pm in Kolkata
});
afterEach(() => vi.useRealTimers());

describe("Catch me up (spec 2026-10-18 §5.3, canvas board CatchUp)", () => {
  it("offered, then reading, then three lines; Close puts it away", async () => {
    let answer!: (v: unknown) => void;
    vi.mocked(aiClient.catchUp).mockReturnValue(new Promise((r) => (answer = r)) as never);
    const { container } = render(<CatchUp leadId="l1" tz={TZ} />);
    expect(
      screen.getByText("New to this lead? LUME AI can sum up its history in three lines."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Catch me up" }));
    expect(aiClient.catchUp).toHaveBeenCalledWith("l1");
    expect(screen.getByText("Catching you up…").closest("section")).toHaveAttribute("aria-busy", "true");
    answer(ok({ read: { id: "c1", lines: LINES } }));
    const heading = await screen.findByRole("heading", { name: "Catch-up" });
    expect(container.querySelector('[aria-live="polite"]')).toContainElement(heading);
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(LINES);
    expect(screen.getByText("From this lead's notes and calls")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(container).toBeEmptyDOMElement();
  });

  it("at the week's limit, it says when LUME AI is back, and offers no button", async () => {
    vi.mocked(aiClient.catchUp).mockResolvedValue(
      ok({ unavailable: "limit" as const, by: "week" as const, until: "2026-10-25T18:30:00.000Z" }),
    );
    render(<CatchUp leadId="l1" tz={TZ} />);
    await userEvent.click(screen.getByRole("button", { name: "Catch me up" }));
    expect(
      await screen.findByText("LUME AI has reached this week's limit. It's back Monday."),
    ).toHaveAttribute("role", "status");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("when the read fails, Try again asks again", async () => {
    vi.mocked(aiClient.catchUp)
      .mockResolvedValueOnce(ok({ unavailable: "failed" as const }))
      .mockResolvedValueOnce(ok({ read: { id: "c1", lines: LINES } }));
    render(<CatchUp leadId="l1" tz={TZ} />);
    await userEvent.click(screen.getByRole("button", { name: "Catch me up" }));
    expect(await screen.findByText("LUME couldn't catch you up just now.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Catch-up" })).toBeInTheDocument();
  });

  it("if LUME AI was switched off meanwhile, it goes away", async () => {
    vi.mocked(aiClient.catchUp).mockResolvedValue(ok({ unavailable: "off" as const }));
    const { container } = render(<CatchUp leadId="l1" tz={TZ} />);
    await userEvent.click(screen.getByRole("button", { name: "Catch me up" }));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
