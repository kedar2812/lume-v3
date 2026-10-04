import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyticsClient } from "@/lib/analytics/client";
import { leadsClient } from "@/lib/leads/client";
import { AnalyticsRefresh } from "@/components/analytics/AnalyticsRefresh";
import { ReloadRefresh } from "./ReloadRefresh";

vi.mock("@/lib/leads/client", () => ({ leadsClient: { counts: vi.fn() } }));
vi.mock("@/lib/analytics/client", () => ({ analyticsClient: { refresh: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe("Refresh without a sheet (Leads and the board)", () => {
  it("counts what arrived since you looked, reloads, and lands on the count; the sidebar looks again", async () => {
    vi.mocked(leadsClient.counts).mockResolvedValue(ok({ counts: {}, values: {}, total: 3 }));
    const onReload = vi.fn();
    const sidebar = vi.fn();
    window.addEventListener("lume:views-changed", sidebar);
    render(<ReloadRefresh pipelineId="p1" onReload={onReload} />);
    act(() => screen.getByRole("button", { name: /Refresh/ }).click());
    await tick(100);
    expect(screen.getByRole("button", { name: /Refresh/ })).toHaveAttribute("data-phase", "lifting");
    await tick(1600);
    const asked = vi.mocked(leadsClient.counts).mock.calls[0]![0];
    expect(asked).toMatchObject({ pipelineId: "p1" });
    expect(Date.parse(asked.arrivedAfter!)).not.toBeNaN();
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(sidebar).toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("3 new leads since you looked.");
    await tick(2000);
    expect(screen.getByRole("button", { name: /3 new/ })).toBeInTheDocument();
    await tick(2000);
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveAttribute("data-phase", "idle");
    window.removeEventListener("lume:views-changed", sidebar);
  });

  it("nothing new: Up to date", async () => {
    vi.mocked(leadsClient.counts).mockResolvedValue(ok({ counts: {}, values: {}, total: 0 }));
    render(<ReloadRefresh pipelineId="p1" onReload={vi.fn()} />);
    act(() => screen.getByRole("button", { name: /Refresh/ }).click());
    await tick(3700);
    expect(screen.getByRole("button", { name: /Up to date/ })).toBeInTheDocument();
  });
});

describe("Analytics' Refresh", () => {
  it("recounts, then the boards read their numbers again", async () => {
    vi.mocked(analyticsClient.refresh).mockResolvedValue(
      ok({ recounted: true, countedAt: new Date().toISOString() }),
    );
    const onRecounted = vi.fn();
    render(<AnalyticsRefresh onRecounted={onRecounted} />);
    act(() => screen.getByRole("button", { name: /Refresh/ }).click());
    await tick(1600);
    expect(analyticsClient.refresh).toHaveBeenCalledTimes(1);
    expect(onRecounted).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Numbers recounted just now.");
  });

  it("a refusal says so and doesn't reload the boards", async () => {
    vi.mocked(analyticsClient.refresh).mockResolvedValue({
      ok: false,
      status: 500,
      code: "X",
      message: "LUME couldn't recount right now.",
    } as never);
    const onRecounted = vi.fn();
    render(<AnalyticsRefresh onRecounted={onRecounted} />);
    act(() => screen.getByRole("button", { name: /Refresh/ }).click());
    await tick(1600);
    expect(onRecounted).not.toHaveBeenCalled();
    expect(screen.getByText("Couldn’t recount")).toBeInTheDocument();
  });
});
