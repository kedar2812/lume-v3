import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { liveSheetsClient, type LiveSheetView } from "@/lib/live-sheets/client";
import { LiveSheetCard } from "./LiveSheetCard";

vi.mock("@/lib/live-sheets/client", async (orig) => {
  const real = await orig<typeof import("@/lib/live-sheets/client")>();
  return {
    ...real,
    liveSheetsClient: {
      run: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      takeOver: vi.fn(),
      remove: vi.fn(),
      remake: vi.fn(),
      connectStart: vi.fn(),
    },
  };
});

const NOW = Date.parse("2026-11-14T10:00:00Z");
const sheet = (over: Partial<LiveSheetView> = {}): LiveSheetView => ({
  id: "s1",
  name: "Qualified leads",
  preset: "meta",
  rule: {
    stages: { mode: "reached", stageIds: ["q"] },
    includeMissing: true,
    includeDnc: false,
    backfill: true,
  },
  ruleWords: "Leads that reached Qualified, from Instagram",
  columns: [],
  edits: "keep",
  status: "live",
  pauseReason: null,
  lastError: null,
  url: "https://docs.google.com/spreadsheets/d/abc/edit",
  leadCount: 1284,
  capped: false,
  lastSyncedAt: new Date(NOW - 2 * 60_000).toISOString(),
  run: null,
  madeBy: { id: "u1", name: "Maya Kapoor" },
  canChange: true,
  runsAs: { id: "u1", name: "Maya Kapoor" },
  createdAt: "2026-11-14T09:00:00Z",
  ...over,
});
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

const card = (s: LiveSheetView, o: { canTakeOver?: boolean } = {}) => {
  const onChange = vi.fn();
  const onEdit = vi.fn();
  const onDeleted = vi.fn();
  render(
    <LiveSheetCard
      sheet={s}
      canTakeOver={o.canTakeOver ?? false}
      onChange={onChange}
      onEdit={onEdit}
      onDeleted={onDeleted}
    />,
  );
  return { onChange, onEdit, onDeleted };
};

describe("LiveSheetCard", () => {
  it("says what it holds, that it's live and when it last updated, with its link to copy", () => {
    card(sheet());
    expect(screen.getByRole("heading", { name: "Qualified leads" })).toBeInTheDocument();
    expect(screen.getByText("Leads that reached Qualified, from Instagram")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("1,284")).toBeInTheDocument();
    expect(screen.getByText(/Updated 2 min ago/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.getByText("Meta audience")).toBeInTheDocument();
  });

  it("a run under way shows its bar, in words", () => {
    card(sheet({ status: "updating", run: { total: 1300, written: 500, status: "running" } }));
    expect(screen.getByText("Writing leads: 500 of 1,300")).toBeInTheDocument();
    expect(screen.getByText("Updating")).toBeInTheDocument();
  });

  it("Google slow: said under the card, without alarm", () => {
    card(sheet({ lastError: "Google is slow right now; LUME will keep going." }));
    expect(screen.getByText("Google is slow right now; LUME will keep going.")).toBeInTheDocument();
  });

  it("Update now asks for a run and shows the answer", async () => {
    const updated = sheet({ run: { total: 0, written: 0, status: "queued" } });
    vi.mocked(liveSheetsClient.run).mockResolvedValue(ok({ sheet: updated }) as never);
    const { onChange } = card(sheet());
    await userEvent.click(screen.getByRole("button", { name: "Update now" }));
    expect(liveSheetsClient.run).toHaveBeenCalledWith("s1");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(updated));
  });

  it("each pause says why, with its own fix", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    vi.mocked(liveSheetsClient.connectStart).mockResolvedValue(
      ok({ url: "https://relay.test/start?x" }) as never,
    );
    card(sheet({ status: "paused", pauseReason: "google_disconnected" }));
    expect(screen.getByText(/can't reach the Google account it writes with/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Connect Google again" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://relay.test/start?x"));
    vi.unstubAllGlobals();
  });

  it("the maker gone: Take it over only for someone who can", () => {
    card(sheet({ status: "paused", pauseReason: "maker_gone" }), { canTakeOver: false });
    expect(screen.queryByRole("button", { name: "Take it over" })).toBeNull();
  });

  it("Take it over, for an admin", async () => {
    vi.mocked(liveSheetsClient.takeOver).mockResolvedValue(ok({ sheet: sheet() }) as never);
    card(sheet({ status: "paused", pauseReason: "maker_gone" }), { canTakeOver: true });
    await userEvent.click(screen.getByRole("button", { name: "Take it over" }));
    expect(liveSheetsClient.takeOver).toHaveBeenCalledWith("s1");
  });

  it("the sheet gone in Google: Make it again", async () => {
    vi.mocked(liveSheetsClient.remake).mockResolvedValue(ok({ sheet: sheet({ status: "making" }) }) as never);
    card(sheet({ status: "paused", pauseReason: "sheet_gone", url: null }));
    await userEvent.click(screen.getByRole("button", { name: "Make it again" }));
    expect(liveSheetsClient.remake).toHaveBeenCalledWith("s1");
  });

  it("Pause and Resume", async () => {
    vi.mocked(liveSheetsClient.pause).mockResolvedValue(ok({ sheet: sheet() }) as never);
    card(sheet());
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(liveSheetsClient.pause).toHaveBeenCalledWith("s1");
  });

  it("Delete asks first, says the file stays, and can move it to Google's bin", async () => {
    vi.mocked(liveSheetsClient.remove).mockResolvedValue(
      ok({ deleted: true as const, trashed: true, url: null }) as never,
    );
    const { onDeleted } = card(sheet());
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete “Qualified leads”" });
    expect(dialog).toHaveTextContent("LUME stops updating it. The sheet stays in Google Drive");
    await userEvent.click(screen.getByRole("checkbox", { name: "Also move the sheet to Google's bin" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete live sheet" }));
    expect(liveSheetsClient.remove).toHaveBeenCalledWith("s1", true);
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("s1"));
  });

  it("more leads than a sheet holds: it says it keeps the newest", () => {
    card(sheet({ capped: true, leadCount: 100000 }));
    expect(screen.getByText(/keeps the newest 100,000/)).toBeInTheDocument();
  });
});

describe("LiveSheetCard: someone else's sheet (bug hunt 2026-11-17)", () => {
  it("shows Update now and the link, never Edit, Pause, Delete or Make it again", () => {
    card(sheet({ canChange: false }));
    expect(screen.getByRole("button", { name: "Update now" })).toBeInTheDocument();
    for (const name of ["Edit", "Pause", "Delete"]) expect(screen.queryByRole("button", { name })).toBeNull();
  });
  it("paused by its maker: no Resume for someone else", () => {
    card(sheet({ canChange: false, status: "paused", pauseReason: "paused_by_person" }));
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });
});
