import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { analyticsClient, type Funnel } from "@/lib/analytics/client";
import { FunnelBoard } from "./FunnelBoard";

vi.mock("@/lib/analytics/client", () => ({ analyticsClient: { funnel: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const stage = (id: string, name: string, reached: number, kind = "open") => ({
  id,
  name,
  kind,
  reached,
  share: reached / 100,
  stopped: 0,
  stoppedN: 0,
  tooFew: false,
  trend: null,
  drill: { reached: `t-${id}` },
});
const funnel = (over: Partial<Funnel> = {}): Funnel => ({
  range: { label: "", days: [] },
  arrived: 100,
  previousArrived: 80,
  stages: [stage("s1", "New", 100), stage("s2", "Replied", 40), stage("s3", "Won", 8, "won")],
  now: {
    stages: [{ id: "s1", name: "New", n: 30, value: 90000, avgAgeDays: 2.4, drill: "now-s1" }],
    openN: 30,
    openValue: 90000,
  },
  timeInStage: [
    {
      id: "s1",
      name: "New",
      exited: 60,
      medianMinutes: 600,
      p75Minutes: 2880,
      slaHours: 24,
      stuckNow: 3,
      tooFew: false,
      drill: { stuck: "stuck-s1" },
    },
  ],
  velocity: {
    openLeads: 30,
    winRate: 0.2,
    avgDeal: 5000,
    cycleDays: 6,
    perDay: 5000,
    previousPerDay: 4000,
    trend: { dir: "up", tone: "good", text: "+25%" },
    cycleHist: {
      edges: [1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60, 90, 120, 180, 365],
      counts: [0, 0, 0, 1, 5, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      median: 4,
    },
  },
  forecast: {
    months: [
      { month: "2026-10", label: "October", latest: 1000, second: 500, earlier: 200 },
      { month: "2026-11", label: "November", latest: 300, second: 0, earlier: 0 },
      { month: "2026-12", label: "December", latest: 0, second: 0, earlier: 0 },
    ],
    later: 400,
    stageNames: ["Proposal", "Call booked"],
  },
  ...over,
});
const drill = vi.fn();
const board = (f: Funnel | null = funnel()) =>
  render(
    <FunnelBoard
      funnel={f}
      params={{ range: "30d", compare: true }}
      rangeWords="in the last 30 days"
      currency="INR"
      onDrill={drill}
    />,
  );

beforeEach(() => vi.clearAllMocks());

describe("the Funnel board (canvas Funnel)", () => {
  it("has the canvas's five cards", () => {
    board();
    for (const name of [
      "How far the leads got",
      "In each stage now",
      "Time in each stage",
      "Pipeline velocity",
      "Forecast",
    ])
      expect(screen.getByRole("region", { name })).toBeInTheDocument();
  });

  it("the ribbon says how far they got, and a stage's numbers open its leads", async () => {
    board();
    const rib = screen.getByRole("region", { name: "How far the leads got" });
    expect(within(rib).getByRole("img", { name: "The funnel, as a ribbon" })).toHaveTextContent("40%");
    await userEvent.click(within(rib).getByRole("button", { name: "See the 40 leads that reached Replied" }));
    expect(drill).toHaveBeenCalledWith("t-s2", "Reached Replied");
  });

  it("split by source asks for the split and draws each source's layer", async () => {
    vi.mocked(analyticsClient.funnel).mockResolvedValue(
      ok(
        funnel({
          split: {
            by: "source",
            groups: [
              {
                id: "a",
                name: "Website",
                arrived: 60,
                stages: [
                  { id: "s1", reached: 60, share: 1 },
                  { id: "s2", reached: 30, share: 0.5 },
                  { id: "s3", reached: 6, share: 0.1 },
                ],
              },
              {
                id: "b",
                name: "Referrals",
                arrived: 40,
                stages: [
                  { id: "s1", reached: 40, share: 1 },
                  { id: "s2", reached: 10, share: 0.25 },
                  { id: "s3", reached: 2, share: 0.05 },
                ],
              },
            ],
          },
        }),
      ) as never,
    );
    board();
    await userEvent.click(screen.getByRole("radio", { name: "Source" }));
    expect(vi.mocked(analyticsClient.funnel).mock.calls[0]![0]).toMatchObject({ split: "source" });
    const rib = screen.getByRole("region", { name: "How far the leads got" });
    expect(await within(rib).findByText("Referrals")).toBeInTheDocument();
    expect(within(rib).getByText("Website")).toBeInTheDocument();
  });

  it("a split from the old range goes as soon as the range changes, not when the new one arrives", async () => {
    const split = funnel({
      split: {
        by: "source",
        groups: [{ id: "b", name: "Referrals", arrived: 40, stages: [{ id: "s1", reached: 40, share: 1 }] }],
      },
    });
    vi.mocked(analyticsClient.funnel).mockResolvedValueOnce(ok(split) as never);
    const props = { funnel: funnel(), rangeWords: "in the last 30 days", currency: "INR", onDrill: drill };
    const { rerender } = render(<FunnelBoard {...props} params={{ range: "30d", compare: true }} />);
    await userEvent.click(screen.getByRole("radio", { name: "Source" }));
    expect(await screen.findByText("Referrals")).toBeInTheDocument();
    vi.mocked(analyticsClient.funnel).mockReturnValueOnce(new Promise(() => {}) as never);
    rerender(<FunnelBoard {...props} params={{ range: "7d", compare: true }} />);
    await waitFor(() => expect(screen.queryByText("Referrals")).not.toBeInTheDocument());
  });

  it("velocity reads as a sum, with how long wins take and the median's bar marked", () => {
    board();
    const v = screen.getByRole("region", { name: "Pipeline velocity" });
    expect(v).toHaveTextContent("30open leads×20%win rate×");
    expect(v).toHaveTextContent("+25%");
    expect(
      within(v)
        .getByRole("img", { name: "Wins by how many days they took" })
        .querySelectorAll("[data-median]"),
    ).toHaveLength(1);
  });

  it("stuck leads open from the card's corner; the forecast has a Later column", async () => {
    board();
    await userEvent.click(screen.getByRole("button", { name: "3 stuck" }));
    expect(drill).toHaveBeenCalledWith("stuck-s1", "Stuck in New");
    expect(screen.getByRole("region", { name: "Forecast" })).toHaveTextContent("Later");
  });

  it("without the money permission: no velocity or forecast cards", () => {
    board(funnel({ velocity: null, forecast: null }));
    expect(screen.queryByRole("region", { name: "Pipeline velocity" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Forecast" })).toBeNull();
  });

  it("nothing arrived yet: it says so, plainly", () => {
    board(funnel({ arrived: 0, stages: [stage("s1", "New", 0), stage("s2", "Won", 0, "won")] }));
    expect(
      screen.getByText("No leads arrived in this range yet. The funnel fills as they do."),
    ).toBeInTheDocument();
  });
});
