import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testCatalog } from "@/lib/leads/test-catalog";
import { liveSheetsClient, type LiveSheetView } from "@/lib/live-sheets/client";
import type { LiveSheetEvent } from "@/lib/notifications/stream";
import { LiveSheetsScreen } from "./LiveSheetsScreen";

let streamed: ((e: LiveSheetEvent) => void) | null = null;
vi.mock("@/lib/notifications/stream", () => ({
  useLiveSheets: (on: (e: LiveSheetEvent) => void) => {
    streamed = on;
  },
}));
vi.mock("@/lib/live-sheets/client", async (orig) => {
  const real = await orig<typeof import("@/lib/live-sheets/client")>();
  return {
    ...real,
    liveSheetsClient: { get: vi.fn(), list: vi.fn(), count: vi.fn(), grants: vi.fn() },
  };
});

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const sheet = (over: Partial<LiveSheetView> = {}): LiveSheetView => ({
  id: "s1",
  name: "Qualified leads",
  preset: "meta",
  rule: {
    stages: { mode: "reached", stageIds: ["s-booked"] },
    includeMissing: true,
    includeDnc: false,
    backfill: true,
  },
  ruleWords: "Leads that reached Call booked",
  columns: [],
  edits: "keep",
  status: "live",
  pauseReason: null,
  lastError: null,
  url: "https://docs.google.com/spreadsheets/d/abc/edit",
  leadCount: 12,
  capped: false,
  lastSyncedAt: null,
  run: null,
  madeBy: { id: "u1", name: "Maya" },
  canChange: true,
  runsAs: { id: "u1", name: "Maya" },
  createdAt: "2026-11-14T09:00:00Z",
  ...over,
});
const screenWith = (o: Partial<Parameters<typeof LiveSheetsScreen>[0]> = {}) =>
  render(
    <LiveSheetsScreen
      initial={[]}
      catalog={testCatalog()}
      contactsVisible
      canTakeOver={false}
      lock={null}
      {...o}
    />,
  );

beforeEach(() => {
  vi.clearAllMocks();
  streamed = null;
  vi.mocked(liveSheetsClient.count).mockResolvedValue(ok({ matching: 0, missingContact: 0 }) as never);
  vi.mocked(liveSheetsClient.grants).mockResolvedValue(ok({ grants: [] }) as never);
});

describe("LiveSheetsScreen", () => {
  it("empty: says what a live sheet is, with the way to make one", async () => {
    screenWith();
    expect(screen.getByRole("heading", { name: "Live sheets", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("No live sheets yet")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Create a live sheet" })[0]!);
    expect(screen.getByRole("dialog", { name: "Create a live sheet" })).toBeInTheDocument();
  });

  it("each sheet's card, and the stream moves one on without a reload", async () => {
    screenWith({ initial: [sheet()] });
    expect(screen.getByRole("heading", { name: "Qualified leads" })).toBeInTheDocument();
    vi.mocked(liveSheetsClient.get).mockResolvedValue(
      ok({
        sheet: sheet({ status: "updating", run: { total: 400, written: 200, status: "running" } }),
      }) as never,
    );
    await act(async () => streamed?.({ sheet: "s1", kind: "progress" }));
    expect(await screen.findByText("Writing leads: 200 of 400")).toBeInTheDocument();
  });

  it("a sheet deleted elsewhere leaves the page; back after the stream was away, the list is read again", async () => {
    screenWith({ initial: [sheet()] });
    vi.mocked(liveSheetsClient.get).mockResolvedValue({
      ok: false,
      status: 404,
      code: "LIVE_SHEET_NOT_FOUND",
      message: "x",
    } as never);
    await act(async () => streamed?.({ sheet: "s1", kind: "status" }));
    expect(screen.queryByRole("heading", { name: "Qualified leads" })).toBeNull();
    vi.mocked(liveSheetsClient.list).mockResolvedValue(
      ok({ sheets: [sheet({ id: "s2", name: "Won" })] }) as never,
    );
    await act(async () => streamed?.({ sheet: "*", kind: "reconnected" }));
    expect(await screen.findByRole("heading", { name: "Won" })).toBeInTheDocument();
  });

  it("on Base: says live sheets come with Pro, no form", () => {
    screenWith({
      lock: { kind: "tier", words: "Live sheets come with Pro, Max and Enterprise. Your LUME is on Base." },
    });
    expect(
      screen.getByText("Live sheets come with Pro, Max and Enterprise. Your LUME is on Base."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create a live sheet" })).toBeNull();
  });

  it("Google Sheets off: says how to switch it on", () => {
    screenWith({
      lock: {
        kind: "sheets_off",
        words: "Switch on Google Sheets in Settings → Integrations to make live sheets.",
      },
    });
    expect(screen.getByText(/Switch on Google Sheets/)).toBeInTheDocument();
  });
});
