import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { analyticsClient, type Goals } from "@/lib/analytics/client";
import { GoalsEditor } from "./GoalsEditor";

vi.mock("@/lib/analytics/client", async (orig) => {
  const real = await orig<typeof import("@/lib/analytics/client")>();
  return {
    ...real,
    analyticsClient: {
      goals: vi.fn(),
      setGoal: vi.fn(),
      removeGoal: vi.fn(),
      overview: vi.fn(),
      teams: vi.fn(),
    },
  };
});
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const c = vi.mocked(analyticsClient);
const goal = (o: Partial<Goals["goals"][number]>): Goals["goals"][number] => ({
  id: "g1",
  scope: "business",
  scopeId: null,
  metric: "won",
  target: 120,
  value: 9,
  progress: 0.075,
  pace: null,
  elapsed: 0.1,
  daysLeft: 26,
  ...o,
});
let goals: Goals;
const people = [
  { id: "u1", name: "Riya Shah", active: true },
  { id: "u2", name: "Dev Malhotra", active: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  goals = { period: "month", periodStart: "2026-10-01", periodEnd: "2026-10-31", goals: [goal({})] };
  c.goals.mockImplementation(async () => ok(goals));
  c.setGoal.mockResolvedValue(ok({ id: "g2" }));
  c.removeGoal.mockResolvedValue(ok(undefined));
  c.teams.mockResolvedValue(ok({ teams: [{ id: "t1", name: "Inbound", memberIds: ["u1"] }] }));
  c.overview.mockResolvedValue(
    ok({
      range: { label: "September", days: [] },
      tiles: [
        { id: "won", value: 112, previous: null, trend: null },
        { id: "revenue_won", value: 5_840_000, previous: null, trend: null },
      ],
      series: { days: [], newLeads: [], won: [], previous: { newLeads: [], won: [] }, bySource: [] },
      drill: {},
    }),
  );
});
const props = { currency: "INR", seesMoney: true, people, today: "2026-10-05" };

describe("Settings → Goals (8D-3)", () => {
  it("shows this month's goals, and last month beside each with Same and +10%", async () => {
    render(<GoalsEditor {...props} />);
    const won = await screen.findByRole("textbox", { name: "Won, the business, October 2026" });
    await waitFor(() => expect(won).toHaveValue("120"));
    expect(c.overview).toHaveBeenCalledWith({
      range: "custom",
      from: "2026-09-01",
      to: "2026-09-30",
      compare: false,
    });
    const card = screen.getByRole("region", { name: "The business" });
    expect(await within(card).findByText("₹58.4L")).toBeInTheDocument();
  });

  it("+10% fills and saves; leaving a box empty removes its goal", async () => {
    render(<GoalsEditor {...props} />);
    const card = screen.getByRole("region", { name: "The business" });
    await within(card).findByText("₹58.4L");
    const row = within(card)
      .getByRole("textbox", { name: /^Won, the business/ })
      .closest("div")!;
    await userEvent.click(within(row).getByRole("button", { name: "+10%" }));
    expect(c.setGoal).toHaveBeenCalledWith({
      scope: "business",
      scopeId: null,
      metric: "won",
      period: "month",
      periodStart: "2026-10-01",
      target: 123,
    });
    const won = screen.getByRole("textbox", { name: /^Won, the business/ });
    await userEvent.clear(won);
    await userEvent.tab();
    expect(c.removeGoal).toHaveBeenCalledWith("g1");
  });

  it("a person's goal, and a team's, save under their own scope; nonsense isn't saved", async () => {
    render(<GoalsEditor {...props} />);
    const riya = await screen.findByRole("textbox", { name: "Won, Riya Shah, October 2026" });
    await userEvent.type(riya, "15");
    await userEvent.tab();
    expect(c.setGoal).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: "user", scopeId: "u1", target: 15 }),
    );
    const team = await screen.findByRole("textbox", { name: "Calls held, Inbound, October 2026" });
    await userEvent.type(team, "abc");
    await userEvent.tab();
    expect(team).toHaveAttribute("aria-invalid", "true");
    expect(c.setGoal).toHaveBeenCalledTimes(1);
  });

  it("a save still in flight when the period changes never brings the old period back", async () => {
    c.goals.mockImplementation(async (start) =>
      ok(
        start === "2026-11-01"
          ? { period: "month" as const, periodStart: start, periodEnd: "2026-11-30", goals: [] }
          : goals,
      ),
    );
    let finish: (v: unknown) => void = () => {};
    c.setGoal.mockImplementation(() => new Promise((r) => (finish = r)) as never);
    render(<GoalsEditor {...props} />);
    const won = await screen.findByRole("textbox", { name: "Won, the business, October 2026" });
    await waitFor(() => expect(won).toHaveValue("120"));
    await userEvent.clear(won);
    await userEvent.type(won, "130");
    // Leaving the box saves; the next month is picked while that save is still on its way.
    await userEvent.click(screen.getByRole("button", { name: "The period after" }));
    const nov = await screen.findByRole("textbox", { name: "Won, the business, November 2026" });
    finish(ok({ id: "g1" }));
    await waitFor(() => expect(c.setGoal).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("November 2026")).toBeInTheDocument();
    expect(nov).toHaveValue("");
  });

  it("what's typed in one box stays while another box's save comes back", async () => {
    let finish: (v: unknown) => void = () => {};
    c.setGoal.mockImplementationOnce(() => new Promise((r) => (finish = r)) as never);
    render(<GoalsEditor {...props} />);
    const riya = await screen.findByRole("textbox", { name: "Won, Riya Shah, October 2026" });
    await userEvent.type(riya, "15");
    const dev = screen.getByRole("textbox", { name: "Won, Dev Malhotra, October 2026" });
    await userEvent.click(dev);
    await userEvent.type(dev, "12");
    finish(ok({ id: "g9" }));
    await waitFor(() => expect(c.goals).toHaveBeenCalledTimes(2));
    expect(dev).toHaveValue("12");
    await userEvent.tab();
    expect(c.setGoal).toHaveBeenLastCalledWith(expect.objectContaining({ scopeId: "u2", target: 12 }));
  });

  it("the period moves a month at a time, or a quarter", async () => {
    render(<GoalsEditor {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "The period before" }));
    expect(screen.getByText("September 2026")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Quarter" }));
    expect(screen.getByText("Q4 2026")).toBeInTheDocument();
    await waitFor(() => expect(c.goals).toHaveBeenLastCalledWith("2026-10-01", "quarter"));
  });

  it("previews Analytics and the email as you type, and names who sees it (never a guessed he or she)", async () => {
    render(<GoalsEditor {...props} />);
    const side = screen.getByRole("complementary", { name: "How these goals will read" });
    await waitFor(() => expect(side).toHaveTextContent("9 of 120"));
    expect(side).toHaveTextContent("What Riya sees");
    expect(side).toHaveTextContent("Riya’s own goals");
    expect(side.textContent).not.toMatch(/\b(he|she|his|her)\b/i);
  });

  it("without the money permission there's no revenue goal to set", async () => {
    render(<GoalsEditor {...props} seesMoney={false} />);
    await screen.findByRole("textbox", { name: /^Won, the business/ });
    expect(screen.queryByRole("textbox", { name: /^Revenue won, the business/ })).not.toBeInTheDocument();
  });
});
