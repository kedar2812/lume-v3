import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calendarClient } from "@/lib/calendar/client";
import type { CalendarConnection, LastSync } from "@/lib/calendar/types";
import { CalendarRefresh } from "./CalendarRefresh";
import { landedWords, syncWords } from "./useCalendarRefresh";

vi.mock("@/lib/calendar/client", () => ({
  calendarClient: { sync: vi.fn(), connection: vi.fn(), connect: vi.fn() },
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const SINCE = "2026-10-01T10:00:00.000Z";
const conn = (last: LastSync | null): CalendarConnection => ({
  available: true,
  connected: true,
  googleEmail: "maya@example.com",
  status: "active",
  calendars: [],
  lastSyncedAt: last?.at ?? null,
  lastSync: last,
  lastError: null,
  lastFailedAt: null,
});
const sync = (at: string, n: Partial<LastSync> = {}): LastSync => ({
  at,
  added: 0,
  moved: 0,
  cancelled: 0,
  changed: 0,
  ...n,
});

describe("Refresh's words", () => {
  it("say what changed, newest kind first, and Up to date when nothing did", () => {
    expect(syncWords(sync(SINCE, { added: 1, changed: 2, moved: 1 }))).toBe(
      "1 new meeting · 1 moved · 2 updated",
    );
    expect(syncWords(sync(SINCE, { added: 2, cancelled: 1 }))).toBe("2 new meetings · 1 cancelled");
    expect(syncWords(sync(SINCE))).toBe("Up to date");
  });

  it("the button lands on the total", () => {
    expect(landedWords(sync(SINCE, { added: 1, changed: 2, moved: 1 }))).toBe("4 updated");
    expect(landedWords(sync(SINCE))).toBe("Up to date");
    expect(landedWords(null)).toBe("Still syncing");
  });
});

describe("the calendar's Refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());
  const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

  it("lifts into the pill, syncs, waits for a newer sync, says what changed, and lands on the count", async () => {
    vi.mocked(calendarClient.sync).mockResolvedValue({
      ...ok({ queued: true as const, since: SINCE }),
      status: 202,
    });
    vi.mocked(calendarClient.connection)
      .mockResolvedValueOnce(ok(conn(sync("2026-10-01T09:55:00.000Z", { added: 9 })))) // the old one: keep waiting
      .mockResolvedValue(ok(conn(sync("2026-10-01T10:00:02.000Z", { added: 1, changed: 2 }))));
    const onSynced = vi.fn();
    render(<CalendarRefresh onSynced={onSynced} />);
    act(() => screen.getByRole("button", { name: /Refresh/ }).click());
    await tick(100);
    expect(screen.getByRole("button", { name: /Refresh/ })).toHaveAttribute("data-phase", "lifting");
    await tick(600);
    expect(screen.getByRole("button", { name: /Refresh/ })).toHaveAttribute("data-phase", "syncing");
    await tick(1800);
    expect(screen.getByRole("status")).toHaveTextContent("1 new meeting · 2 updated");
    expect(onSynced).not.toHaveBeenCalled(); // the rows wash as the card lands, not before
    await tick(1500);
    expect(onSynced).toHaveBeenCalledWith(sync("2026-10-01T10:00:02.000Z", { added: 1, changed: 2 }));
    await tick(700);
    expect(screen.getByRole("button", { name: /3 updated/ })).toBeInTheDocument();
    await tick(2000);
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveAttribute("data-phase", "idle");
  });

  it("the bar follows the sync: a sliver when asked, each calendar read, saving, and full only when it's done", async () => {
    vi.mocked(calendarClient.sync).mockResolvedValue({
      ...ok({ queued: true as const, since: SINCE }),
      status: 202,
    });
    const old = conn(sync("2026-10-01T09:55:00.000Z"));
    vi.mocked(calendarClient.connection)
      .mockResolvedValueOnce(ok({ ...old, syncProgress: { stage: "reading" as const, done: 0, total: 2 } }))
      .mockResolvedValueOnce(ok({ ...old, syncProgress: { stage: "reading" as const, done: 1, total: 2 } }))
      .mockResolvedValueOnce(ok({ ...old, syncProgress: { stage: "saving" as const, done: 2, total: 2 } }))
      .mockResolvedValue(ok(conn(sync("2026-10-01T10:00:02.000Z", { added: 1 }))));
    render(<CalendarRefresh onSynced={vi.fn()} />);
    act(() => screen.getByRole("button", { name: /Refresh/ }).click());
    const bar = () => Number(screen.getByRole("progressbar", { hidden: true }).getAttribute("aria-valuenow"));
    await tick(600);
    const asked = bar();
    expect(asked).toBeLessThan(20);
    await tick(600);
    expect(screen.getByText("Reading calendar 1 of 2…")).toBeInTheDocument();
    const first = bar();
    await tick(600);
    expect(screen.getByText("Reading calendar 2 of 2…")).toBeInTheDocument();
    const second = bar();
    await tick(600);
    expect(screen.getByText("Saving meetings with your leads…")).toBeInTheDocument();
    const saving = bar();
    await tick(600);
    const done = bar();
    expect([asked, first, second, saving, done]).toEqual(
      [...[asked, first, second, saving, done]].sort((a, b) => a - b),
    );
    expect(new Set([asked, first, second, saving, done]).size).toBe(5);
    expect(done).toBe(100);
  });

  it("after 30 seconds without a newer sync, says it's still syncing and to Refresh again — nothing it can't keep", async () => {
    vi.mocked(calendarClient.sync).mockResolvedValue({
      ...ok({ queued: true as const, since: SINCE }),
      status: 202,
    });
    vi.mocked(calendarClient.connection).mockResolvedValue(ok(conn(sync("2026-10-01T09:55:00.000Z"))));
    render(<CalendarRefresh onSynced={vi.fn()} />);
    act(() => screen.getByRole("button", { name: /Refresh/ }).click());
    await tick(32_000);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Still syncing. Refresh again in a minute to see it.",
    );
  });

  it("Review: a sync that failed after the press says so, with Google's words, and that LUME tries again", async () => {
    vi.mocked(calendarClient.sync).mockResolvedValue({
      ...ok({ queued: true as const, since: SINCE }),
      status: 202,
    });
    vi.mocked(calendarClient.connection)
      // An older failure, from before the press: not this Refresh's answer.
      .mockResolvedValueOnce(
        ok({
          ...conn(sync("2026-10-01T09:55:00.000Z")),
          lastError: "Old trouble",
          lastFailedAt: "2026-10-01T09:58:00.000Z",
        }),
      )
      .mockResolvedValue(
        ok({
          ...conn(sync("2026-10-01T09:55:00.000Z")),
          lastError: "Couldn't reach Google.",
          lastFailedAt: "2026-10-01T10:00:03.000Z",
        }),
      );
    render(<CalendarRefresh onSynced={vi.fn()} />);
    act(() => screen.getByRole("button", { name: /Refresh/ }).click());
    await tick(5000);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Couldn't reach Google. LUME will try again on its own.",
    );
    expect(screen.getByRole("status")).not.toHaveTextContent("Still syncing");
  });

  it("a connection that needs reconnecting turns Refresh into Connect again, never a spinner forever", async () => {
    vi.mocked(calendarClient.sync).mockResolvedValue({
      ok: false,
      status: 409,
      code: "CALENDAR_NEEDS_RECONNECT",
      message: "Google stopped letting LUME read your calendar. Connect it again.",
    });
    render(<CalendarRefresh onSynced={vi.fn()} />);
    act(() => screen.getByRole("button", { name: /Refresh/ }).click());
    await tick(5000);
    expect(screen.getByRole("button", { name: "Connect again" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Google stopped letting LUME read your calendar");
  });

  it("starts as Connect again when the connection already needs it", () => {
    render(<CalendarRefresh onSynced={vi.fn()} needsReconnect />);
    expect(screen.getByRole("button", { name: "Connect again" })).toBeInTheDocument();
  });
});
