import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunAsk, RunLead } from "@/lib/autopilot/types";
import { ReadyColumn } from "./ReadyColumn";

const toast = vi.fn();
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));

const lead = (o: Partial<RunLead> & { leadId: string; name: string }): RunLead => ({
  state: "ready",
  reason: null,
  card: null,
  thought: null,
  repliedAt: "2026-10-26T08:00:00.000Z",
  draft: null,
  nextAt: null,
  lastSentAt: "2026-10-26T08:00:00.000Z",
  updatedAt: "2026-10-26T08:00:00.000Z",
  ...o,
});
const rohan = lead({
  leadId: "b",
  name: "Rohan Gupta",
  state: "ready",
  card: { headline: "Reached Site visit booked", quote: "Saturday 4 pm works" },
});
const anika = lead({
  leadId: "c",
  name: "Anika Rao",
  state: "needs_you",
  reason: "LUME AI wanted to quote a price that isn't in your price list.",
  card: { headline: "Waiting for you", quote: "How much for the full flat?" },
});
const ask: RunAsk = {
  id: "k1",
  leadId: "c",
  action: "answer_prices",
  payload: { message: "The full flat is about ₹9 lakh.", fileIds: [], updates: null },
  createdAt: "2026-10-26T08:00:00.000Z",
};
const props = (o: Partial<Parameters<typeof ReadyColumn>[0]> = {}) => ({
  leads: [rohan, anika],
  asks: [] as RunAsk[],
  canDecide: true,
  onTakeOver: vi.fn(),
  onCarryOn: vi.fn(),
  onApprove: vi.fn(async () => undefined),
  onDecline: vi.fn(async () => undefined),
  ...o,
});

beforeEach(() => vi.clearAllMocks());

/** Ready for you (Autopilot spec 2026-10-19 §2): converted and stuck leads, the deal at a glance, one tap to step in. */
describe("ReadyColumn", () => {
  it("Converted and Needs you, each counted; each card has the deal and the lead's own words", () => {
    render(<ReadyColumn {...props()} />);
    expect(screen.getByRole("heading", { name: "Ready for you, 2" })).toBeInTheDocument();
    const converted = screen.getByRole("group", { name: "Converted, 1" });
    expect(converted).toHaveTextContent("Reached Site visit booked");
    expect(within(converted).getByText("Saturday 4 pm works").closest("blockquote")).not.toBeNull();
    const needs = screen.getByRole("group", { name: "Needs you, 1" });
    expect(needs).toHaveTextContent("LUME AI wanted to quote a price that isn't in your price list.");
  });

  it("Take over, or let LUME AI carry on (the person who started it, or an admin)", async () => {
    const p = props();
    const { rerender } = render(<ReadyColumn {...p} />);
    const card = screen.getByRole("article", { name: "Rohan Gupta" });
    await userEvent.click(within(card).getByRole("button", { name: "Take over" }));
    expect(p.onTakeOver).toHaveBeenCalledWith("b");
    await userEvent.click(within(card).getByRole("button", { name: "Let LUME AI carry on" }));
    expect(p.onCarryOn).toHaveBeenCalledWith("b");
    rerender(<ReadyColumn {...p} canDecide={false} />);
    expect(screen.queryByRole("button", { name: "Let LUME AI carry on" })).toBeNull();
  });

  it("a card that arrives while watching rings once and says so; the ones there at first don't", () => {
    const p = props({ leads: [anika] });
    const { rerender } = render(<ReadyColumn {...p} />);
    expect(toast).not.toHaveBeenCalled();
    rerender(<ReadyColumn {...p} leads={[rohan, anika]} />);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Rohan reached Site visit booked. Want to take over?" }),
    );
    expect(screen.getByRole("article", { name: "Rohan Gupta" })).toHaveAttribute("data-new");
  });

  it("Ask me: what LUME AI wants to do, in words; one tap does it, once", async () => {
    let finish!: () => void;
    const p = props({
      asks: [ask],
      onApprove: vi.fn(() => new Promise<undefined>((r) => (finish = () => r(undefined)))),
    });
    render(<ReadyColumn {...p} />);
    const q = screen.getByRole("region", { name: "Waiting for you, 1" });
    expect(q).toHaveTextContent("Answer price questions");
    expect(q).toHaveTextContent("Anika Rao");
    expect(q).toHaveTextContent("The full flat is about ₹9 lakh.");
    const doIt = within(q).getByRole("button", { name: "Send it" });
    await userEvent.click(doIt);
    await userEvent.click(doIt);
    expect(p.onApprove).toHaveBeenCalledTimes(1);
    finish();
    await userEvent.click(within(q).getByRole("button", { name: "Hand it to me" }));
    expect(p.onDecline).toHaveBeenCalledWith("k1");
  });

  it("nothing yet: says what will land here", () => {
    render(<ReadyColumn {...props({ leads: [] })} />);
    expect(
      screen.getByText("When a lead reaches the goal, or needs a person, LUME AI brings them here."),
    ).toBeInTheDocument();
  });
});
