import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { analyticsClient, type Lost, type Segments } from "@/lib/analytics/client";
import { LostBoard } from "./LostBoard";

vi.mock("@/lib/analytics/client", async (orig) => {
  const real = await orig<typeof import("@/lib/analytics/client")>();
  return { ...real, analyticsClient: { segments: vi.fn() } };
});
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

const lost = (o: Partial<Lost> = {}): Lost => ({
  range: { label: "Last 30 days", days: [] },
  total: 100,
  previousTotal: 80,
  reasons: [
    { id: "r1", name: "No reply", n: 60, before: 40, share: 0.6, trend: null, drill: "d-r1" },
    { id: "r2", name: "Price", n: 40, before: 40, share: 0.4, trend: null, drill: "d-r2" },
  ],
  stages: [
    { id: "s1", name: "New", n: 70, drill: "d-s1" },
    { id: "s2", name: "Replied", n: 30, drill: "d-s2" },
  ],
  owners: [],
  sources: [],
  wonBack: { n: 3 },
  matrix: {
    reasons: [
      { id: "r1", name: "No reply" },
      { id: "r2", name: "Price" },
    ],
    sources: [
      { id: "x1", name: "Instagram" },
      { id: null, name: "Added in LUME" },
    ],
    cells: [
      { reasonId: "r1", sourceId: "x1", n: 50, tooFew: false, drill: "d-c1" },
      { reasonId: "r2", sourceId: null, n: 2, tooFew: true, drill: "d-c2" },
    ],
  },
  wonBackFlow: {
    lost: 120,
    reopened: 12,
    won: 3,
    value: 9000,
    previousValue: 6000,
    trend: { dir: "up", tone: "good", text: "+50%" },
    drill: "d-wb",
  },
  ...o,
});
const seg = (field: string | null): Segments => ({
  range: { label: "Last 30 days", days: [] },
  field: field ? { key: field, label: field === "budget" ? "Budget" : "Goal", type: "select" } : null,
  groups: field
    ? [
        { value: "o1", label: "Under 25k", arrived: 40, won: 2, rate: 0.05, tooFew: false, drill: "d-g1" },
        { value: "o2", label: "Over 1L", arrived: 30, won: 6, rate: 0.2, tooFew: false, drill: "d-g2" },
        { value: null, label: "Not answered", arrived: 4, won: 0, rate: 0, tooFew: true },
      ]
    : [],
  fields: [
    { key: "budget", label: "Budget", type: "select" },
    { key: "goal", label: "Goal", type: "select" },
  ],
});
const props = {
  insights: null,
  params: { range: "30d" as const, compare: true },
  rangeWords: "in the last 30 days",
  rangeDays: 30,
  currency: "AED",
  compare: true,
  onDrill: vi.fn(),
};

beforeEach(() => {
  props.onDrill = vi.fn();
  vi.mocked(analyticsClient.segments).mockClear();
  vi.mocked(analyticsClient.segments).mockImplementation(async (_p, field) => ok(seg(field ?? null)));
});

describe("Lost board (canvas Lost)", () => {
  it("why they were lost: each reason's count and share, each opening its leads", async () => {
    render(<LostBoard lost={lost()} {...props} />);
    const card = screen.getByRole("region", { name: "Why they were lost" });
    expect(card).toHaveTextContent("100 leads lost in the last 30 days");
    const reply = within(card).getByRole("button", { name: /No reply/ });
    expect(reply).toHaveTextContent("6060%");
    await userEvent.click(reply);
    expect(props.onDrill).toHaveBeenCalledWith("d-r1", "Lost: No reply");
  });

  it("reasons by source: every cell is a number that opens its leads; empty cells can't be opened", async () => {
    render(<LostBoard lost={lost()} {...props} />);
    const grid = screen.getByRole("table", { name: "Leads lost, by reason and source" });
    await userEvent.click(within(grid).getByRole("button", { name: "No reply from Instagram: 50 leads" }));
    expect(props.onDrill).toHaveBeenCalledWith("d-c1", "Lost: No reply, from Instagram");
    expect(within(grid).getByRole("button", { name: "Price from Instagram: 0 leads" })).toBeDisabled();
  });

  it("won back: lost, reopened, won, and the money recovered", async () => {
    render(<LostBoard lost={lost()} {...props} />);
    const card = screen.getByRole("region", { name: "Won back" });
    expect(card).toHaveTextContent("reopened · 10.0%");
    expect(card).toHaveTextContent("won · 25% of reopened");
    expect(card).toHaveTextContent("recovered from leads once marked lost");
    expect(card).toHaveTextContent("+50%");
    await userEvent.click(within(card).getByRole("button", { name: "Won back: 3. See the leads." }));
    expect(props.onDrill).toHaveBeenCalledWith("d-wb", "Won back");
  });

  it("what converts: the first field's answers by win rate, the best in green, another field on a click", async () => {
    render(<LostBoard lost={lost()} {...props} />);
    const card = screen.getByRole("region", { name: "What converts" });
    const best = await within(card).findByRole("button", { name: /^Over 1L: 20\.0% won/ });
    expect(best.querySelector("[data-best]")).not.toBeNull();
    expect(within(card).getByRole("button", { name: /^Not answered/ })).toHaveTextContent("Too few");
    await userEvent.click(within(card).getByRole("radio", { name: "Goal" }));
    expect(analyticsClient.segments).toHaveBeenLastCalledWith(props.params, "goal");
  });

  it("what converts drops the old range's answers as soon as the range changes", async () => {
    const { rerender } = render(<LostBoard lost={lost()} {...props} />);
    expect(await screen.findByRole("button", { name: /^Over 1L/ })).toBeInTheDocument();
    vi.mocked(analyticsClient.segments).mockReturnValue(new Promise(() => {}) as never);
    rerender(<LostBoard lost={lost()} {...props} params={{ range: "7d", compare: true }} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Over 1L/ })).not.toBeInTheDocument());
  });

  it("over 92 days, what converts says to pick a shorter range instead of asking", () => {
    render(<LostBoard lost={lost()} {...props} rangeDays={365} />);
    expect(screen.getByRole("region", { name: "What converts" })).toHaveTextContent("Pick a shorter range");
    expect(analyticsClient.segments).not.toHaveBeenCalled();
  });

  it("without the money permission the recovered money isn't shown", () => {
    const flow = { ...lost().wonBackFlow };
    delete flow.value;
    delete flow.previousValue;
    render(<LostBoard lost={lost({ wonBackFlow: { ...flow, trend: null } })} {...props} />);
    expect(screen.queryByText("recovered from leads once marked lost")).not.toBeInTheDocument();
  });
});
