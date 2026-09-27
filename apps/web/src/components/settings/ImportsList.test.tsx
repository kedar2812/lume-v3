import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importsClient } from "@/lib/imports/client";
import type { ImportView } from "@/lib/imports/types";
import { ImportsList } from "./ImportsList";

vi.mock("@/lib/imports/client", () => ({ importsClient: { list: vi.fn(), draft: vi.fn(), get: vi.fn() } }));
// The sheet is tested on its own; here it only needs to say which import it was opened with.
vi.mock("@/components/imports/ImportSheet", () => ({
  ImportSheet: ({ open, draftId, importId }: { open: boolean; draftId?: string; importId?: string }) =>
    open ? <div role="dialog" aria-label="Import leads" data-draft={draftId} data-import={importId} /> : null,
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const counts = {
  created: 0,
  merged: 0,
  skipped: 0,
  empty: 0,
  errors: 0,
  warnings: 0,
  nameFromContact: 0,
  missingStageFields: 0,
  phoneNeedsCountry: 0,
};
const imp = (over: Partial<ImportView>): ImportView => ({
  id: "i1",
  status: "done",
  fileName: "leads.csv",
  rowCount: 10,
  cursorRow: 11,
  counts,
  startedBy: { id: "u-riya", name: "Riya Sharma" },
  createdAt: "2026-09-20T09:00:00Z",
  startedAt: "2026-09-20T09:01:00Z",
  finishedAt: "2026-09-20T09:02:00Z",
  seenAt: null,
  stopReason: null,
  sourceId: "s1",
  canSeeRows: true,
  mine: true,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("ImportsList", () => {
  it("lists imports newest first, with what happened, who ran them and when", async () => {
    vi.mocked(importsClient.list).mockResolvedValue(
      ok({
        imports: [
          imp({
            id: "i3",
            fileName: "march.csv",
            counts: { ...counts, created: 812, merged: 40, errors: 3 },
          }),
          imp({ id: "i2", fileName: "half.csv", status: "stopped_access", stopReason: "access_changed" }),
          imp({ id: "i1", fileName: "draft.csv", status: "draft", startedBy: null, startedAt: null }),
        ],
        nextCursor: null,
      }),
    );
    render(<ImportsList />);
    const rows = await screen.findAllByRole("listitem");
    expect(rows.map((r) => within(r).getByRole("heading").textContent)).toEqual([
      "march.csv",
      "half.csv",
      "draft.csv",
    ]);
    expect(within(rows[0]!).getByText("Done")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("812 created · 40 merged · 3 with problems")).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/Riya Sharma/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Stopped: access changed")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Draft")).toBeInTheDocument();
  });

  it("continues a draft and opens a finished import's report in the sheet", async () => {
    vi.mocked(importsClient.list).mockResolvedValue(
      ok({
        imports: [imp({ id: "done1" }), imp({ id: "draft1", status: "draft", startedAt: null })],
        nextCursor: null,
      }),
    );
    render(<ImportsList />);
    await userEvent.click(await screen.findByRole("button", { name: "Continue draft leads.csv" }));
    expect(screen.getByRole("dialog", { name: "Import leads" })).toHaveAttribute("data-draft", "draft1");
  });

  it("opens the report of a finished import", async () => {
    vi.mocked(importsClient.list).mockResolvedValue(
      ok({ imports: [imp({ id: "done1" })], nextCursor: null }),
    );
    render(<ImportsList />);
    await userEvent.click(await screen.findByRole("button", { name: "Open the report for leads.csv" }));
    expect(screen.getByRole("dialog", { name: "Import leads" })).toHaveAttribute("data-import", "done1");
  });

  it("loads older imports with the cursor", async () => {
    vi.mocked(importsClient.list)
      .mockResolvedValueOnce(ok({ imports: [imp({ id: "new" })], nextCursor: "new" }))
      .mockResolvedValueOnce(ok({ imports: [imp({ id: "old", fileName: "old.csv" })], nextCursor: null }));
    render(<ImportsList />);
    await userEvent.click(await screen.findByRole("button", { name: "Load earlier" }));
    expect(importsClient.list).toHaveBeenLastCalledWith("new");
    expect(await screen.findByRole("heading", { name: "old.csv" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load earlier" })).not.toBeInTheDocument();
  });

  it("says so when there's nothing yet", async () => {
    vi.mocked(importsClient.list).mockResolvedValue(ok({ imports: [], nextCursor: null }));
    render(<ImportsList />);
    expect(await screen.findByText(/No imports yet/)).toBeInTheDocument();
  });
});
