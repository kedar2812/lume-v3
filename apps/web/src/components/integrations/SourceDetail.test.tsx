import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sheetsClient } from "@/lib/sheets/client";
import type { SheetSourceDetail } from "@/lib/sheets/types";
import { SourceDetail } from "./SourceDetail";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/sheets/client", () => ({
  sheetsClient: {
    get: vi.fn(),
    sync: vi.fn(),
    patch: vi.fn(),
    remove: vi.fn(),
    dismiss: vi.fn(),
    connect: vi.fn(),
    problemsUrl: (id: string) => `/api/v1/sheets/sources/${id}/problems.csv`,
  },
}));
vi.mock("@/components/sheets/AddSheetSheet", () => ({
  AddSheetSheet: ({ open, sourceId }: { open: boolean; sourceId?: string }) =>
    open ? <div role="dialog" aria-label="Sheet columns" data-source={sourceId} /> : null,
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const detail = (over: Partial<SheetSourceDetail> = {}): SheetSourceDetail => ({
  id: "s1",
  name: "Website enquiries",
  status: "active",
  attention: null,
  tabTitle: "Form responses",
  link: "https://docs.google.com/spreadsheets/d/x/edit#gid=0",
  pollSeconds: 120,
  lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
  nextSyncAt: new Date(Date.now() + 60_000).toISOString(),
  syncing: false,
  failing: false,
  lastError: null,
  newColumns: [],
  newToday: 3,
  newAllTime: 120,
  problems: 1,
  runAs: { id: "u1", name: "Riya Sharma" },
  canSeeRows: true,
  auth: "service_account",
  syncs: [
    {
      id: "y1",
      trigger: "refresh",
      status: "done",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      created: 3,
      merged: 1,
      errors: 1,
      error: null,
    },
    {
      id: "y2",
      trigger: "schedule",
      status: "done",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      created: 0,
      merged: 0,
      errors: 0,
      error: null,
    },
  ],
  problemRows: [
    {
      id: 9,
      rowNumber: 14,
      problems: [{ code: "DATE_INVALID", message: "“someday” isn't a date LUME can read." }],
      lastTriedAt: new Date().toISOString(),
    },
  ],
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("a sheet's page", () => {
  it("shows its health, recent syncs in words, problem rows, and a way back", async () => {
    vi.mocked(sheetsClient.get).mockResolvedValue(ok(detail()));
    render(<SourceDetail id="s1" />);
    expect(await screen.findByRole("heading", { name: "Website enquiries" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Integrations" })).toHaveAttribute(
      "href",
      "/settings/integrations",
    );
    expect(screen.getByRole("link", { name: /Open in Google Sheets/ })).toHaveAttribute("target", "_blank");
    expect(screen.getByText("120")).toBeInTheDocument();
    const syncs = screen.getByRole("table", { name: "Recent syncs" });
    expect(within(syncs).getByText("3 new · 1 merged · 1 problem")).toBeInTheDocument();
    expect(within(syncs).getByText("Up to date")).toBeInTheDocument();
    expect(within(syncs).getByText("Refresh")).toBeInTheDocument();
    expect(screen.getByText(/Row 14/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download problem rows" })).toHaveAttribute(
      "href",
      "/api/v1/sheets/sources/s1/problems.csv",
    );
    expect(screen.getByText(/Runs as Riya Sharma/)).toBeInTheDocument();
  });

  it("a lost share offers Test again; a changed column offers the columns", async () => {
    vi.mocked(sheetsClient.get).mockResolvedValueOnce(
      ok(
        detail({
          status: "needs_attention",
          attention: { code: "ACCESS_LOST", message: "LUME can't open this sheet any more." },
        }),
      ),
    );
    vi.mocked(sheetsClient.sync).mockResolvedValue(ok({ syncId: "y3" }));
    vi.mocked(sheetsClient.get).mockResolvedValue(ok(detail()));
    const { unmount } = render(<SourceDetail id="s1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Test again" }));
    expect(sheetsClient.sync).toHaveBeenCalledWith("s1");
    unmount();
    vi.mocked(sheetsClient.get).mockResolvedValue(
      ok(
        detail({
          status: "needs_attention",
          attention: { code: "COLUMNS_CHANGED", message: "The column “Name” is now called “Full name”." },
        }),
      ),
    );
    render(<SourceDetail id="s1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Open columns" }));
    expect(screen.getByRole("dialog", { name: "Sheet columns" })).toHaveAttribute("data-source", "s1");
  });

  it("a sheet connected with Google whose access was removed offers Connect again, for this sheet", async () => {
    vi.mocked(sheetsClient.get).mockResolvedValue(
      ok(
        detail({
          status: "needs_attention",
          auth: "oauth",
          attention: {
            code: "ACCESS_LOST",
            message: "Google access for this sheet was removed. Connect it again.",
          },
        }),
      ),
    );
    vi.mocked(sheetsClient.connect).mockResolvedValue(ok({ url: "https://connect.example.test/start?n=1" }));
    const assign = vi.fn();
    const was = window.location;
    Object.defineProperty(window, "location", { value: { ...was, assign }, writable: true });
    render(<SourceDetail id="s1" />);
    expect(screen.queryByRole("button", { name: "Test again" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Connect again" }));
    expect(sheetsClient.connect).toHaveBeenCalledWith({ sourceId: "s1" });
    expect(assign).toHaveBeenCalledWith("https://connect.example.test/start?n=1");
    Object.defineProperty(window, "location", { value: was, writable: true });
  });

  it("someone who can't see the sheet's contacts gets no download and no column editing", async () => {
    vi.mocked(sheetsClient.get).mockResolvedValue(ok(detail({ canSeeRows: false })));
    render(<SourceDetail id="s1" />);
    await screen.findByRole("heading", { name: "Website enquiries" });
    expect(screen.queryByRole("link", { name: "Download problem rows" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit columns and rules" })).toBeNull();
  });

  it("pause, dismiss a problem, and remove only after saying the leads stay", async () => {
    vi.mocked(sheetsClient.get).mockResolvedValue(ok(detail()));
    vi.mocked(sheetsClient.patch).mockResolvedValue(ok({ ...detail(), status: "paused" }));
    vi.mocked(sheetsClient.dismiss).mockResolvedValue(ok(null));
    vi.mocked(sheetsClient.remove).mockResolvedValue(ok(null));
    render(<SourceDetail id="s1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Pause" }));
    expect(sheetsClient.patch).toHaveBeenCalledWith("s1", { paused: true });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss row 14" }));
    expect(sheetsClient.dismiss).toHaveBeenCalledWith("s1", 9);
    await userEvent.click(screen.getByRole("button", { name: "Remove sheet" }));
    const ask = screen.getByRole("dialog", { name: "Remove this sheet?" });
    expect(ask).toHaveTextContent("Its leads stay in LUME");
    await userEvent.click(within(ask).getByRole("button", { name: "Remove" }));
    expect(sheetsClient.remove).toHaveBeenCalledWith("s1");
    expect(push).toHaveBeenCalledWith("/settings/integrations");
  });
});
