import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { healthClient, type Health } from "@/lib/settings/health";
import { SystemHealth } from "./SystemHealth";

vi.mock("@/lib/settings/health", () => ({ healthClient: { get: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const at = "2026-09-28T10:00:00.000Z";
const healthy: Health = {
  checkedAt: at,
  followUps: { lastSweepAt: "2026-09-28T09:59:28.000Z", pending: 12, late: 0, firedToday: 40 },
  queue: { waiting: 3, active: 0, retrying: 0, failed24h: 0 },
  digest: { lastSentAt: "2026-09-28T04:00:00.000Z", sentToday: 6, failures24h: 0 },
  noTouch: { enabled: true, lastRunAt: null, createdToday: 0 },
  sources: [{ id: "s1", name: "Site form", type: "webhook", status: "active", lastSyncAt: null }],
  restoreTest: { at: "2026-09-27T03:00:00.000Z", ok: true },
  problems: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(healthClient.get).mockResolvedValue(ok(healthy));
});
afterEach(() => vi.useRealTimers());

describe("System health (3C Task 7)", () => {
  it("one look: everything is running, and each promise with its numbers", () => {
    render(<SystemHealth initial={healthy} />);
    expect(screen.getByRole("heading", { name: "Everything is running" })).toBeInTheDocument();
    const reminders = screen.getByRole("region", { name: "Follow-up reminders" });
    expect(within(reminders).getByText("32 s ago")).toBeInTheDocument();
    expect(within(reminders).getByText("12")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Morning emails" })).toHaveTextContent("6");
    expect(screen.getByRole("region", { name: "Sources" })).toHaveTextContent("Site form");
    expect(screen.getByRole("region", { name: "Backups" })).toHaveTextContent(/passed/);
  });

  it("what needs a look, in words", () => {
    render(
      <SystemHealth
        initial={{
          ...healthy,
          followUps: { ...healthy.followUps, late: 2 },
          problems: [
            { key: "reminders_late", words: "2 reminders are late: restart LUME's API." },
            { key: "digest_failing", words: "Morning emails aren't going out." },
          ],
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "2 things need a look" })).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "What needs a look" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(list).toHaveTextContent("Morning emails aren't going out.");
  });

  it("checks again every 30 s while it's on screen, and not while the tab is hidden", async () => {
    vi.useFakeTimers();
    render(<SystemHealth initial={healthy} />);
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(healthClient.get).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => void (await vi.advanceTimersByTimeAsync(90_000)));
    expect(healthClient.get).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(healthClient.get).toHaveBeenCalledTimes(2); // back on screen: at once
  });
});
